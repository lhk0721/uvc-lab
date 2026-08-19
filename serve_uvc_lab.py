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
import json
import os
import socket
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
    FOURCC_CANDIDATES,
    MODE_CANDIDATES,
    SETTLE_FRAMES,
    add_environment_args,
    backend_name,
    describe_signal,
    fourcc_of,
    frame_signal,
    list_devices,
    open_capture,
    query_controls,
    resolve_environment,
    set_capture_defaults,
    set_control,
)
from uvc_lab_presets import (
    PRESETS_BY_ID,
    normalise_params,
    public_presets,
)

PAGE = ROOT / "uvc_lab.html"
SNAPSHOT_DIR = ROOT / "tmp" / "uvc"

# Box-local state (docs/design/lab-desk-spec.md §3.1): the rig lives on the
# Jetson because the wiring is a property of the box, not of any laptop.
# UVC_LAB_HOME exists so tests can point this at a scratch directory.
STATE_DIR = Path(os.environ.get("UVC_LAB_HOME") or Path.home() / ".uvc-lab")
RIG_PATH = STATE_DIR / "rig.json"
PROFILES_PATH = STATE_DIR / "profiles.json"
VERSION_FILE = STATE_DIR / "VERSION"


class DeviceBroker:
    """Any number of previews at once, all preemptible by one exclusive user.

    The registration screen streams every camera simultaneously (spec §4), so
    previews are readers — one per device, running concurrently. A run or an
    enumeration is the writer: it cannot simply wait for the previews (they
    hold their slot for as long as they stream), so it signals preemption,
    each preview loop checks that flag per frame and bows out, and the
    exclusive section enters once the last preview has left.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._previews = 0
        self._exclusive = False
        self._preempt = threading.Event()

    @property
    def should_yield(self) -> bool:
        return self._preempt.is_set()

    @contextlib.contextmanager
    def exclusive(self, timeout: float = 30.0):
        deadline = time.monotonic() + timeout
        self._preempt.set()
        with self._cond:
            while self._previews > 0 or self._exclusive:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._cond.wait(timeout=remaining):
                    self._preempt.clear()
                    # Waiters block on the flag we just cleared — wake them so
                    # they re-check instead of sitting out their own timeout.
                    self._cond.notify_all()
                    raise RuntimeError("camera is busy — another run is still holding it")
            self._exclusive = True
        self._preempt.clear()
        try:
            yield
        finally:
            with self._cond:
                self._exclusive = False
                self._cond.notify_all()

    @contextlib.contextmanager
    def preview(self, timeout: float = 10.0):
        # Do not race a pending preemption: a run that just asked for the
        # device must not lose it to a preview reconnecting at the same moment.
        deadline = time.monotonic() + timeout
        with self._cond:
            while self._exclusive or self._preempt.is_set():
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not self._cond.wait(timeout=remaining):
                    raise RuntimeError("camera is busy")
            self._previews += 1
        try:
            yield
        finally:
            with self._cond:
                self._previews -= 1
                self._cond.notify_all()


broker = DeviceBroker()
runs: dict[str, dict[str, Any]] = {}
runs_lock = threading.Lock()
stream_stats: dict[int, dict[str, Any]] = {}  # one entry per streaming index

app = FastAPI(title="UVC Camera Lab")


class RunRequest(BaseModel):
    preset: str
    params: dict = {}
    # Spec §5: a run started past a rig mismatch ("무시하고 진행") records the
    # status it ran under, so no result is left without its configuration.
    rigStatus: str | None = None
    # Spec 8: a run started from a test profile records which profile it was,
    # next to the rig status, so a number is never left without its setup.
    profileId: str | None = None


class ControlRequest(BaseModel):
    index: int
    key: str
    value: int


@app.get("/")
def index():
    if not PAGE.is_file():
        raise HTTPException(500, f"missing page: {PAGE}")
    return FileResponse(PAGE)


@app.get("/api/health")
def api_health():
    # Discovery calls this to tell a provisioned box (and version drift) from
    # a bare SSH host. The version is the marker the bootstrap writes; a
    # checkout run by hand has no marker and honestly reports "dev".
    try:
        version = VERSION_FILE.read_text(encoding="utf-8").strip() or "dev"
    except OSError:
        version = "dev"
    return {"app": "uvc-lab", "version": version, "hostname": socket.gethostname()}


@app.get("/api/devices")
def api_devices(max_index: int = 5):
    try:
        with broker.exclusive(timeout=20):
            devices = list_devices(max_index=max_index)
    except RuntimeError as exc:
        raise HTTPException(409, str(exc))
    # camId / controlProfile / usb are None on the index-scan fallback
    # (Windows dev machine); on the Jetson they come from by-path enumeration.
    # opened=False means the node exists but another process holds it — the
    # client must render that as "busy", not as an absent camera (spec §2.3).
    return [
        {"index": d.index, "camId": d.cam_id, "idPath": d.id_path, "opened": d.opened,
         "width": d.width, "height": d.height,
         "signature": d.signature, "os_name": d.os_name,
         "os_name_is_heuristic": d.os_name_is_heuristic,
         "controlProfile": d.control_profile, "usb": d.usb}
        for d in devices
    ]


@app.get("/api/rig")
def api_rig_get():
    # 404 rather than an empty object: the client's `no-rig` state (spec §5)
    # must be distinguishable from a registered-but-empty rig.
    if not RIG_PATH.is_file():
        raise HTTPException(404, "no rig registered on this box")
    try:
        return JSONResponse(json.loads(RIG_PATH.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(500, f"rig.json unreadable: {exc}")


@app.put("/api/rig")
def api_rig_put(rig: dict):
    # Validation is deliberately shallow. The schema (spec §3.2) is owned by
    # the client and will evolve; the server only refuses what it could never
    # serve back sensibly.
    if not isinstance(rig.get("rigVersion"), int):
        raise HTTPException(422, "rigVersion (int) is required")
    if not isinstance(rig.get("cameras"), list):
        raise HTTPException(422, "cameras (list) is required")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = RIG_PATH.with_name(RIG_PATH.name + ".tmp")
    tmp.write_text(json.dumps(rig, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    # Atomic replace: a crash mid-write can never truncate the existing rig.
    tmp.replace(RIG_PATH)
    return rig


@app.get("/api/profiles")
def api_profiles_get():
    # An absent file is an empty set, not a state of its own. Unlike the rig
    # (spec 5's `no-rig`), nothing on the client behaves differently for
    # "none saved yet", so there is nothing for a 404 to tell it.
    if not PROFILES_PATH.is_file():
        return {"profiles": []}
    try:
        data = json.loads(PROFILES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(500, f"profiles.json unreadable: {exc}")
    # A hand-edited file may be the bare list; accept both, write one shape.
    return {"profiles": data.get("profiles", []) if isinstance(data, dict) else data}


@app.put("/api/profiles")
def api_profiles_put(payload: dict):
    # Shallow, like the rig: the schema (spec 8) is the client's. The server
    # only refuses what would break the run record or the client's own lookup.
    profiles = payload.get("profiles")
    if not isinstance(profiles, list):
        raise HTTPException(422, "profiles (list) is required")
    ids = [p.get("id") if isinstance(p, dict) else None for p in profiles]
    if any(not isinstance(i, str) or not i for i in ids):
        raise HTTPException(422, "every profile needs a non-empty string id")
    # The id is what a result is filed under, so a duplicate would make two
    # different setups indistinguishable afterwards.
    if len(set(ids)) != len(ids):
        raise HTTPException(422, "profile ids must be unique")
    for profile in profiles:
        if not isinstance(profile.get("preset"), str):
            raise HTTPException(422, f"{profile.get('id')}: preset (str) is required")
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PROFILES_PATH.with_name(PROFILES_PATH.name + ".tmp")
    tmp.write_text(json.dumps({"profiles": profiles}, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    # Atomic replace, same as the rig: a crash mid-write cannot truncate it.
    tmp.replace(PROFILES_PATH)
    return {"profiles": profiles}


@app.get("/api/modes")
def api_modes():
    # The candidate lists live on the box, in uvc_devices, so the lab screen
    # never carries a second copy of them. These are candidates only — what a
    # camera actually honours is whatever the read-back reports (§7.2).
    return {
        "resolutions": [f"{w}x{h}" for (w, h) in
                        sorted(MODE_CANDIDATES, key=lambda m: -m[0] * m[1])],
        "fourccs": list(FOURCC_CANDIDATES),
    }


def _dev_node(index: int) -> str:
    return f"/dev/video{int(index)}"


@app.get("/api/controls")
def api_controls(index: int = 0):
    # supported=False (no V4L2) is a different answer from "no controls", and
    # the client must not render one as the other (§7.3).
    controls = query_controls(_dev_node(index))
    if controls is None:
        return {"index": index, "supported": False, "controls": []}
    return {"index": index, "supported": True, "controls": controls}


@app.post("/api/controls")
def api_set_control(request: ControlRequest):
    try:
        value = set_control(_dev_node(request.index), request.key, request.value)
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    except OSError as exc:
        # EINVAL = out of range or not settable; EBUSY = a streaming consumer
        # holds it. Both are the device's answer, not a server fault.
        raise HTTPException(409, f"{request.key}: {exc.strerror or exc}")
    except RuntimeError as exc:
        raise HTTPException(501, str(exc))
    # The value the driver kept, not the one that was asked for.
    return {"index": request.index, "key": request.key, "value": value}


@app.get("/api/presets")
def api_presets():
    return public_presets()


@app.get("/api/streams")
def api_streams():
    # Every stream at once: the lab screen previews several cameras and would
    # otherwise poll once per camera (spec §7.1).
    return {"streams": {str(k): v for k, v in stream_stats.items()}}


@app.get("/api/stream/stats")
def api_stream_stats(index: int | None = None):
    # Stats are per index now that previews run concurrently. Without an
    # index (the single-preview page), answer with any active stream so the
    # old flat shape keeps working.
    if index is not None:
        return stream_stats.get(index, {"active": False})
    return next((s for s in stream_stats.values() if s.get("active")), {"active": False})


def _mjpeg(index: int, width: int, height: int, fourcc: str, quality: int,
           fps: int | None = None):
    """Multipart JPEG stream — an <img> tag renders it with no client code."""
    boundary = b"--frame\r\n"
    stats = stream_stats.setdefault(index, {})
    try:
        with broker.preview():
            cap = open_capture(index, width, height, fourcc, fps)
            # Requested vs observed, both kept (spec §7.2): a UVC driver
            # silently substitutes its nearest mode, so showing the request
            # back would report a setting that never took.
            stats.update({"active": True, "index": index, "fps": 0.0,
                          "signal": None, "error": None,
                          "requested": {"width": width, "height": height,
                                        "fourcc": fourcc, "fps": fps},
                          "observed": {
                              "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                              "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
                              "fourcc": fourcc_of(cap),
                              "driverFps": round(cap.get(cv2.CAP_PROP_FPS), 2)}})
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
                        stats["error"] = "frame grab failed"
                        break

                    now = time.perf_counter()
                    window.append(now)
                    if len(window) > 1:
                        span = window[-1] - window[0]
                        if span > 0:
                            stats["fps"] = round((len(window) - 1) / span, 1)
                    # Signal analysis is not free at 2.3MP, so sample it rather
                    # than paying for it on every frame of the preview.
                    if now - checked_at > 1.0:
                        stats["signal"] = frame_signal(frame)
                        checked_at = now

                    encoded, buf = cv2.imencode(
                        ".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
                    if not encoded:
                        continue
                    yield boundary + b"Content-Type: image/jpeg\r\n\r\n" + buf.tobytes() + b"\r\n"
            finally:
                cap.release()
                stats.update({"active": False, "fps": 0.0})
    except (RuntimeError, GeneratorExit):
        stats.update({"active": False})
        return
    except Exception as exc:  # surfaced in the UI rather than dying silently
        stats.update({"active": False, "error": str(exc)})
        return


@app.get("/stream.mjpg")
def api_stream(index: int = 0, resolution: str = "1280x720",
               fourcc: str = "MJPG", quality: int = 80, fps: int | None = None):
    width, height = (int(v) for v in resolution.split("x"))
    return StreamingResponse(
        _mjpeg(index, width, height, fourcc, quality, fps),
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
                        "error": None, "rigStatus": request.rigStatus,
                        "profileId": request.profileId}

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
