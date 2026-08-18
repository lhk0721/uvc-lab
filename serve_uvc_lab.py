"""Browser-based UVC camera lab — live preview plus preset benchmarks.

Runs a small self-contained server so a camera can be aimed and measured from
a browser instead of a terminal. Kept separate from any product service on
purpose: this tool needs exclusive device access that would interfere with
request handling.

It is also the practical way to work with a headless box such as a Jetson —
run the server there, open the page from a laptop, and the preview arrives
over the network.

Device arbitration is the part that needs care. A camera can only be held by
one consumer at a time, so the live preview and a benchmark cannot both own
it. A benchmark therefore *preempts* the preview: it raises a flag, the
preview loop notices and releases the device, and the browser reconnects when
the run finishes. Without this the first benchmark would either fail to open
the camera or, worse, measure a device contended by the preview and report
the interference as the camera's performance.

Usage (from the repo root):
  uv run python serve_uvc_lab.py
  uv run python serve_uvc_lab.py --host 0.0.0.0 --port 8100   # from another machine
"""

from __future__ import annotations

import argparse
import contextlib
import sys
import threading
import time
import traceback
import uuid
from collections import deque
from pathlib import Path
from typing import Any

import cv2
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent

from uvc_devices import (
    SETTLE_FRAMES,
    add_environment_args,
    backend_name,
    describe_signal,
    frame_signal,
    list_devices,
    open_capture,
    resolve_environment,
    set_capture_defaults,
)
from uvc_lab_presets import (
    PRESETS_BY_ID,
    normalise_params,
    public_presets,
)

PAGE = ROOT / "uvc_lab.html"
SNAPSHOT_DIR = ROOT / "tmp" / "uvc"


class DeviceBroker:
    """One consumer per camera at a time, with preview preemptible by runs.

    The preview holds the lock for as long as it streams, so a run cannot
    simply wait for it — it would wait forever. Instead the run signals that
    it wants the device, and the preview loop checks that flag each frame and
    bows out.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._preempt = threading.Event()

    @property
    def should_yield(self) -> bool:
        return self._preempt.is_set()

    @contextlib.contextmanager
    def exclusive(self, timeout: float = 30.0):
        self._preempt.set()
        acquired = self._lock.acquire(timeout=timeout)
        if not acquired:
            self._preempt.clear()
            raise RuntimeError("camera is busy — another run is still holding it")
        try:
            self._preempt.clear()
            yield
        finally:
            self._lock.release()

    @contextlib.contextmanager
    def preview(self, timeout: float = 10.0):
        # Do not race a pending preemption: a run that just asked for the
        # device must not lose it to a preview reconnecting at the same moment.
        deadline = time.monotonic() + timeout
        while self._preempt.is_set() and time.monotonic() < deadline:
            time.sleep(0.05)
        acquired = self._lock.acquire(timeout=max(0.1, deadline - time.monotonic()))
        if not acquired:
            raise RuntimeError("camera is busy")
        try:
            yield
        finally:
            self._lock.release()


broker = DeviceBroker()
runs: dict[str, dict[str, Any]] = {}
runs_lock = threading.Lock()
stream_stats: dict[str, Any] = {"active": False}

app = FastAPI(title="UVC Camera Lab")


class RunRequest(BaseModel):
    preset: str
    params: dict = {}


@app.get("/")
def index():
    if not PAGE.is_file():
        raise HTTPException(500, f"missing page: {PAGE}")
    return FileResponse(PAGE)


@app.get("/api/devices")
def api_devices(max_index: int = 5):
    try:
        with broker.exclusive(timeout=20):
            devices = list_devices(max_index=max_index)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))
    return [
        {"index": d.index, "width": d.width, "height": d.height,
         "signature": d.signature, "os_name": d.os_name,
         "os_name_is_heuristic": d.os_name_is_heuristic}
        for d in devices
    ]


@app.get("/api/presets")
def api_presets():
    return public_presets()


@app.get("/api/stream/stats")
def api_stream_stats():
    return stream_stats


def _mjpeg(index: int, width: int, height: int, fourcc: str, quality: int):
    """Multipart JPEG stream — an <img> tag renders it with no client code."""
    boundary = b"--frame\r\n"
    try:
        with broker.preview():
            cap = open_capture(index, width, height, fourcc, None)
            stream_stats.update({"active": True, "index": index, "fps": 0.0,
                                 "signal": None, "error": None})
            # The first frames after open are null buffers (frame 0 is
            # reliably all-zero); sampling them would report a healthy camera
            # as dead in the UI.
            for _ in range(SETTLE_FRAMES):
                cap.read()
            # Rate over a sliding window of arrival times. NOT an EMA of
            # instantaneous rates: that estimator is biased upward under
            # jitter (mean of 1/x exceeds 1/mean-of-x) and showed a physically
            # impossible 176 fps on a 60 fps device here.
            window: deque[float] = deque(maxlen=60)
            checked_at = 0.0
            try:
                while not broker.should_yield:
                    ok, frame = cap.read()
                    if not ok:
                        stream_stats["error"] = "frame grab failed"
                        break

                    now = time.perf_counter()
                    window.append(now)
                    if len(window) > 1:
                        span = window[-1] - window[0]
                        if span > 0:
                            stream_stats["fps"] = round((len(window) - 1) / span, 1)
                    # Signal analysis is not free at 2.3MP, so sample it rather
                    # than paying for it on every frame of the preview.
                    if now - checked_at > 1.0:
                        stream_stats["signal"] = frame_signal(frame)
                        checked_at = now

                    encoded, buf = cv2.imencode(
                        ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
                    if not encoded:
                        continue
                    yield boundary + b"Content-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
            finally:
                cap.release()
                stream_stats.update({"active": False, "fps": 0.0})
    except (RuntimeError, GeneratorExit):
        stream_stats.update({"active": False})
        return
    except Exception as exc:  # surfaced in the UI rather than dying silently
        stream_stats.update({"active": False, "error": str(exc)})
        return


@app.get("/stream.mjpg")
def api_stream(index: int = 0, resolution: str = "1280x720",
               fourcc: str = "MJPG", quality: int = 80):
    width, height = (int(v) for v in resolution.split("x"))
    return StreamingResponse(
        _mjpeg(index, width, height, fourcc, quality),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/snapshot")
def api_snapshot(index: int = 0, resolution: str = "1920x1200", fourcc: str = "MJPG"):
    width, height = (int(v) for v in resolution.split("x"))
    try:
        with broker.exclusive(timeout=20):
            cap = open_capture(index, width, height, fourcc, None)
            try:
                for _ in range(15):  # let exposure settle before saving
                    cap.read()
                ok, frame = cap.read()
            finally:
                cap.release()
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))
    if not ok or frame is None:
        raise HTTPException(500, "no frame captured")

    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    path = SNAPSHOT_DIR / f"uvc_{index}_{width}x{height}_{int(time.time())}.png"
    cv2.imwrite(str(path), frame)
    signal = frame_signal(frame)
    return {"path": str(path), "signal": signal, "describe": describe_signal(signal)}


def _execute(run_id: str, preset: dict, params: dict) -> None:
    def log(message: str) -> None:
        with runs_lock:
            runs[run_id]["log"].append(message)

    try:
        with broker.exclusive(timeout=60):
            log(f"starting '{preset['title']}'")
            result = preset["runner"](params, log)
        with runs_lock:
            runs[run_id].update({"status": "done", "result": result,
                                 "finished": time.time()})
    except Exception as exc:
        with runs_lock:
            runs[run_id].update({"status": "error", "error": str(exc),
                                 "traceback": traceback.format_exc(),
                                 "finished": time.time()})


@app.post("/api/runs")
def api_start_run(request: RunRequest):
    preset = PRESETS_BY_ID.get(request.preset)
    if preset is None:
        raise HTTPException(404, f"unknown preset: {request.preset}")

    with runs_lock:
        if any(r["status"] == "running" for r in runs.values()):
            raise HTTPException(409, "a run is already in progress")
        run_id = uuid.uuid4().hex[:12]
        runs[run_id] = {"id": run_id, "preset": request.preset,
                        "title": preset["title"], "status": "running",
                        "started": time.time(), "log": [], "result": None,
                        "error": None}

    params = normalise_params(preset, request.params)
    threading.Thread(target=_execute, args=(run_id, preset, params), daemon=True).start()
    return {"run_id": run_id}


@app.get("/api/runs/{run_id}")
def api_run(run_id: str):
    with runs_lock:
        run = runs.get(run_id)
    if run is None:
        raise HTTPException(404, "unknown run")
    return JSONResponse(run)


@app.get("/api/runs")
def api_runs(limit: int = 20):
    with runs_lock:
        ordered = sorted(runs.values(), key=lambda r: r["started"], reverse=True)[:limit]
        return [{k: v for k, v in r.items() if k not in ("result", "traceback")}
                for r in ordered]


def main() -> int:
    parser = argparse.ArgumentParser(description="Browser-based UVC camera lab")
    parser.add_argument("--host", default="127.0.0.1",
                        help="use 0.0.0.0 to reach it from another machine (e.g. a Jetson)")
    parser.add_argument("--port", type=int, default=8100)
    add_environment_args(parser)
    args = parser.parse_args()

    try:
        api, decode_path = resolve_environment(args)
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1
    # Presets call open_capture from many places; one process-wide default
    # applies the chosen path to all of them.
    set_capture_defaults(api=api, decode_path=decode_path)

    print(f"UVC camera lab -> http://{'localhost' if args.host == '127.0.0.1' else args.host}"
          f":{args.port}  (backend={backend_name(api)} decode_path={decode_path})")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
