"""Experiment: resolution x pixel-format sweep — advertised vs achieved fps.

Question: which capture mode should the prototype actually run? The driver
advertises an fps per mode, but advertised and achieved diverge (60 claimed,
41.9 measured at 1920x1200 MJPG). Picking a mode off the spec sheet therefore
risks designing around a rate the rig cannot sustain.

This sweeps every (resolution x fourcc) combination the device honours and
measures the real sustained rate for each, so the resolution/framerate
trade-off is read off measurements instead of the datasheet.

Why it matters beyond raw throughput: motion-fidelity experiments established
30 fps as the floor for our position estimates (15 fps aliases fast motion at
~1.4cm error, 6 fps at 3.3cm). A mode that cannot hold 30 fps is disqualified regardless of how good
its resolution looks, and this table is what decides that.

Each mode is measured in its own capture session — settings applied to a live
device leak into later probes and would silently contaminate the sweep.

Usage (from the repo root):
  uv run python experiment_uvc_modes.py
  uv run python experiment_uvc_modes.py --seconds 5 --json tmp/benchmarks/uvc_modes.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from time import perf_counter

import cv2

from uvc_devices import (
    FOURCC_CANDIDATES,
    MODE_CANDIDATES,
    FrameTimer,
    add_environment_args,
    backend_name,
    environment_summary,
    frame_signal,
    index_probe_api,
    open_capture,
    resolve_environment,
)

WARMUP_FRAMES = 15
FPS_FLOOR = 30.0  # below this, fast motion aliases badly in position estimates


def measure_mode(index: int, width: int, height: int, fourcc: str,
                 seconds: float, request_fps: int, api: int | None = None,
                 decode_path: str | None = None) -> dict | None:
    """Sustained rate for one mode, or None when the device substitutes another."""
    try:
        cap = open_capture(index, width, height, fourcc, request_fps,
                           api=api, decode_path=decode_path)
    except RuntimeError:
        return None

    got_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    got_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    driver_fps = cap.get(cv2.CAP_PROP_FPS)
    if (got_w, got_h) == (0, 0):
        # GStreamer may not expose the negotiated caps as properties; a decoded
        # frame is then the only readback available.
        ok, probe = cap.read()
        if ok and probe is not None:
            got_h, got_w = probe.shape[:2]
    if (got_w, got_h) != (width, height):
        cap.release()
        return None  # substituted -> not a real mode

    for _ in range(WARMUP_FRAMES):
        cap.read()

    timer = FrameTimer()
    deadline = perf_counter() + seconds
    failures = 0
    signal = None
    while perf_counter() < deadline:
        ok, frame = cap.read()
        if not ok or frame is None:
            failures += 1
            if failures > 5:
                break
            continue
        if signal is None:
            # Checked once per mode: a mode can stream null buffers at full
            # rate, and counting that as throughput is how a dead format ends
            # up recommended as the fastest one.
            signal = frame_signal(frame)
        timer.tick()
    cap.release()

    summary = timer.summary()
    if "mean_fps" not in summary:
        return None
    signal = signal or {"state": "none", "mean": 0.0, "max": 0}
    return {
        "width": width, "height": height, "fourcc": fourcc,
        "megapixels": round(width * height / 1e6, 2),
        "driver_fps": round(driver_fps, 1),
        "achieved_fps": summary["mean_fps"],
        "ratio": round(summary["mean_fps"] / driver_fps, 2) if driver_fps else None,
        "interval_ms": summary["interval_ms"],
        "long_gap_pct": summary["long_gap_pct"],
        "pixel_rate_mps": round(width * height * summary["mean_fps"] / 1e6, 1),
        "meets_floor": summary["mean_fps"] >= FPS_FLOOR,
        "signal": signal,
        "usable": signal["state"] == "ok" and summary["mean_fps"] >= FPS_FLOOR,
        "read_failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Sweep UVC capture modes")
    parser.add_argument("--index", type=int, default=None,
                        help="camera index (default: first that opens)")
    parser.add_argument("--seconds", type=float, default=4.0, help="measure time per mode")
    parser.add_argument("--fps", type=int, default=60, help="fps requested from the driver")
    parser.add_argument("--fourcc", nargs="*", default=list(FOURCC_CANDIDATES))
    parser.add_argument("--json", type=Path, default=None)
    add_environment_args(parser)
    args = parser.parse_args()

    try:
        api, decode_path = resolve_environment(args)
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1

    index = args.index
    if index is None:
        for candidate in range(5):
            cap = cv2.VideoCapture(candidate, index_probe_api(api))
            opened = cap.isOpened()
            cap.release()
            if opened:
                index = candidate
                break
    if index is None:
        print("no camera opened", file=sys.stderr)
        return 1

    total = len(args.fourcc) * len(MODE_CANDIDATES)
    print(f"index={index} backend={backend_name(api)} decode_path={decode_path}")
    print(f"sweeping {total} combinations x {args.seconds:.0f}s "
          f"(~{total * (args.seconds + 1.5) / 60:.1f} min)\n")

    results = []
    done = 0
    for fourcc in args.fourcc:
        for (width, height) in MODE_CANDIDATES:
            done += 1
            print(f"  [{done}/{total}] {fourcc} {width}x{height} ... ", end="", flush=True)
            res = measure_mode(index, width, height, fourcc, args.seconds, args.fps,
                               api=api, decode_path=decode_path)
            if res is None:
                print("not supported")
                continue
            flags = []
            if not res["meets_floor"]:
                flags.append("BELOW 30fps FLOOR")
            if res["signal"]["state"] == "dead":
                flags.append("NO SIGNAL (all-zero frames)")
            elif res["signal"]["state"] == "dark":
                flags.append(f"DARK (peak {res['signal']['max']}/255)")
            suffix = ("  " + "; ".join(flags)) if flags else ""
            print(f"{res['achieved_fps']:.1f} fps "
                  f"(driver claims {res['driver_fps']:.0f}){suffix}")
            results.append(res)

    if not results:
        print("\nno supported modes measured", file=sys.stderr)
        return 1

    print("\n" + "=" * 96)
    print(f"{'fourcc':<7}{'mode':>12}{'MP':>7}{'claim':>8}{'actual':>9}{'ratio':>7}"
          f"{'p95 ms':>9}{'gaps%':>8}{'Mpx/s':>9}{'signal':>10}")
    print("=" * 96)
    for r in sorted(results, key=lambda x: (-x["megapixels"], x["fourcc"])):
        mark = " " if r["usable"] else "!"
        print(f"{mark}{r['fourcc']:<6}{r['width']}x{r['height']:>5}{r['megapixels']:>7.2f}"
              f"{r['driver_fps']:>8.0f}{r['achieved_fps']:>9.1f}{r['ratio']:>7.2f}"
              f"{r['interval_ms']['p95']:>9.1f}{r['long_gap_pct']:>8.1f}"
              f"{r['pixel_rate_mps']:>9.1f}{r['signal']['state']:>10}")
    print("=" * 96)
    print(f"'!' marks modes that are unusable — either under the {FPS_FLOOR:.0f} fps floor")
    print(f"    or not carrying a real image (signal != ok).")

    usable = [r for r in results if r["usable"]]
    if usable:
        best = max(usable, key=lambda r: (r["megapixels"], r["achieved_fps"]))
        print(f"\nhighest usable resolution: {best['fourcc']} "
              f"{best['width']}x{best['height']} @ {best['achieved_fps']:.1f} fps")
    else:
        print("\nNO USABLE MODE. Either nothing held the frame-rate floor, or every mode "
              "streamed frames without a real image — fix the signal first.")

    dead = [r for r in results if r["signal"]["state"] == "dead"]
    if dead:
        formats = sorted({r["fourcc"] for r in dead})
        print(f"\n{len(dead)} mode(s) delivered all-zero frames ({', '.join(formats)}). "
              f"Those rates count empty buffers and are not throughput.")

    # A flat pixel rate across modes means the USB link is saturated: the sensor
    # is not the limit, the pipe is. A falling one points at per-frame CPU cost.
    # Only meaningful over modes that actually carry an image.
    rates = [r["pixel_rate_mps"] for r in usable]
    if len(rates) > 1 and (max(rates) - min(rates)) / max(rates) < 0.15:
        print(f"pixel rate is flat across usable modes (~{sum(rates) / len(rates):.0f} Mpx/s) "
              f"-> the USB link is the ceiling, not the sensor.")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({
            "index": index,
            "environment": environment_summary(api, decode_path),
            "seconds_per_mode": args.seconds,
            "fps_floor": FPS_FLOOR,
            "results": results,
        }, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
