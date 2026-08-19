"""Experiment: does auto-exposure cap the frame rate?

Question: the camera advertises 60 fps but delivered 41.9. One candidate is
auto-exposure — a UVC sensor in a dim room lengthens integration time, and
once that exceeds the frame period the sensor drops its own rate to
compensate. 1/42s is 24ms of integration, which is exactly the kind of value
an indoor auto-exposure loop settles on. If that is the cause the fix is free
(fix the exposure, add light) and nothing about USB or decode needs touching.

Method: sweep manual exposure from short to long and measure the sustained
rate at each, then compare against auto. If rate falls as exposure lengthens
and auto lands on the same curve, exposure is the mechanism. If the rate is
flat across the whole sweep, exposure is exonerated and the bottleneck is
transfer or decode — go back to ``bench_uvc_capture.py``.

Also reports mean frame brightness, because the trade is the point: a short
exposure that hits 60 fps but underexposes the lifter is not a win. For a
global-shutter camera on fast barbell movement, motion blur scales with
exposure time, so the shortest exposure that stays adequately lit is the
target.

Exposure units are driver-defined and not portable. On Windows/DirectShow the
value is typically log2 seconds (-6 = 1/64s); on V4L2 it is often
100-microsecond ticks. The script reports what it set and what came back
rather than pretending the number means the same thing everywhere.

Usage (from the repo root):
  uv run python experiment_uvc_exposure.py
  uv run python experiment_uvc_exposure.py --values -3 -4 -5 -6 -7 --seconds 5
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np

from uvc_devices import (
    IS_WINDOWS,
    MAINS_HZ,
    FrameTimer,
    add_environment_args,
    backend_name,
    environment_summary,
    find_index,
    open_capture,
    resolve_environment,
)

WARMUP_FRAMES = 30  # exposure changes need longer to settle than a mode change

# Below this, swing is sensor noise and scene motion. Above it, on a static
# scene, it is a mains beat — measured 39% on a 50Hz-configured camera under
# 60Hz light, 2.4% on the same camera once corrected.
FLICKER_WARN_PCT = 10.0

# DirectShow: 0.25 = manual, 0.75 = auto. V4L2: 1 = manual, 3 = aperture-priority.
AUTO_ON = 0.75 if IS_WINDOWS else 3
AUTO_OFF = 0.25 if IS_WINDOWS else 1

DEFAULT_VALUES_WINDOWS = [-4, -5, -6, -7, -8, -9]      # log2 seconds
DEFAULT_VALUES_V4L2 = [1000, 500, 250, 120, 60, 30]    # 100us ticks


# Enough consecutive samples to see a slow oscillation; the pixel subsample keeps
# the per-frame cost negligible, so this does not distort what is being measured.
BRIGHTNESS_SAMPLES = 600


def measure(cap: cv2.VideoCapture, seconds: float) -> tuple[dict, dict]:
    """Sustained rate plus brightness level AND its variation over the window.

    The mean alone answers "is it lit enough". It cannot answer "is it steady",
    and unsteady is a distinct failure: a 50/60Hz anti-flicker mismatch leaves
    the mean untouched while the frame-to-frame swing reaches tens of percent.
    Sampling has to be consecutive for the same reason — taking every fifth
    frame aliases the very oscillation this is looking for.
    """
    for _ in range(WARMUP_FRAMES):
        cap.read()
    timer = FrameTimer()
    brightness: list[float] = []
    deadline = perf_counter() + seconds
    while perf_counter() < deadline:
        ok, frame = cap.read()
        if not ok:
            break
        timer.tick()
        if len(brightness) < BRIGHTNESS_SAMPLES:
            brightness.append(float(np.mean(frame[::8, ::8])))
    if not brightness:
        nan = float("nan")
        return timer.summary(), {"mean": nan, "sd": nan, "p2p": nan, "p2p_pct": nan}
    values = np.asarray(brightness)
    mean = float(values.mean())
    p2p = float(values.max() - values.min())
    return timer.summary(), {
        "mean": mean,
        "sd": float(values.std()),
        "p2p": p2p,
        # Relative swing is what makes runs at different light levels comparable.
        "p2p_pct": 100.0 * p2p / mean if mean else float("nan"),
        "samples": len(brightness),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Auto vs manual exposure effect on fps")
    parser.add_argument("--index", type=int, default=None)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1200)
    parser.add_argument("--fourcc", default="MJPG", choices=("MJPG", "YUY2"))
    parser.add_argument("--fps", type=int, default=60)
    parser.add_argument("--seconds", type=float, default=5.0, help="measure time per setting")
    parser.add_argument("--values", type=float, nargs="*", default=None,
                        help="manual exposure values (driver units)")
    parser.add_argument("--json", type=Path, default=None)
    add_environment_args(parser)
    args = parser.parse_args()

    try:
        api, decode_path = resolve_environment(args)
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1
    if api == cv2.CAP_GSTREAMER:
        # CAP_PROP_EXPOSURE does not reach v4l2src through an appsink pipeline,
        # so the sweep would silently no-op and measure nothing.
        print("exposure control cannot be driven through a GStreamer pipeline — "
              "use --backend v4l2 here, or v4l2-ctl --set-ctrl on the Jetson.",
              file=sys.stderr)
        return 1

    values = args.values
    if values is None:
        values = DEFAULT_VALUES_WINDOWS if IS_WINDOWS else DEFAULT_VALUES_V4L2

    index = args.index
    if index is None:
        index = find_index((args.width, args.height), api=api)
        if index is None:
            print(f"no camera supports {args.width}x{args.height}", file=sys.stderr)
            return 1
        print(f"auto-detected index {index}")

    cap = open_capture(index, args.width, args.height, args.fourcc, args.fps, api=api)
    driver_fps = cap.get(cv2.CAP_PROP_FPS)
    print(f"index={index} backend={backend_name(api)} "
          f"{args.width}x{args.height} {args.fourcc} driver_fps={driver_fps:.0f}")
    print(f"exposure units are driver-defined; reporting set vs read-back\n")

    results = []

    print("[auto exposure]")
    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, AUTO_ON)
    auto_summary, auto_brightness = measure(cap, args.seconds)
    settled = cap.get(cv2.CAP_PROP_EXPOSURE)
    print(f"  {auto_summary.get('mean_fps', 0):.1f} fps   "
          f"brightness {auto_brightness['mean']:.1f}/255 "
          f"(swing {auto_brightness['p2p_pct']:.1f}% p2p, sd {auto_brightness['sd']:.2f})   "
          f"settled exposure {settled:g}")
    results.append({"mode": "auto", "requested": None, "readback": settled,
                    "fps": auto_summary.get("mean_fps"),
                    "brightness": auto_brightness["mean"], "flicker": auto_brightness,
                    "summary": auto_summary})

    print("\n[manual exposure sweep]")
    supported = cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, AUTO_OFF)
    if not supported:
        print("  warn: driver rejected manual exposure — values below may be ignored")
    for value in values:
        accepted = cap.set(cv2.CAP_PROP_EXPOSURE, value)
        readback = cap.get(cv2.CAP_PROP_EXPOSURE)
        summary, brightness = measure(cap, args.seconds)
        fps = summary.get("mean_fps", 0.0)
        print(f"  exposure {value:>7g} (readback {readback:>7g}, "
              f"{'accepted' if accepted else 'REJECTED'})  "
              f"{fps:>6.1f} fps   brightness {brightness['mean']:>5.1f}/255   "
              f"swing {brightness['p2p_pct']:>5.1f}%")
        results.append({"mode": "manual", "requested": value, "readback": readback,
                        "accepted": bool(accepted), "fps": fps,
                        "brightness": brightness["mean"], "flicker": brightness,
                        "summary": summary})

    cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, AUTO_ON)  # leave the device as we found it
    cap.release()

    manual = [r for r in results if r["mode"] == "manual" and r["fps"]]
    print("\n" + "=" * 72)
    print("VERDICT")
    print("=" * 72)
    if not manual:
        print("  no manual measurements — driver likely does not expose exposure control.")
    else:
        fastest = max(manual, key=lambda r: r["fps"])
        slowest = min(manual, key=lambda r: r["fps"])
        spread = fastest["fps"] - slowest["fps"]
        auto_fps = auto_summary.get("mean_fps", 0.0)
        print(f"  manual range: {slowest['fps']:.1f} - {fastest['fps']:.1f} fps "
              f"(spread {spread:.1f})")
        print(f"  auto        : {auto_fps:.1f} fps")
        if spread >= 5.0:
            print(f"\n  EXPOSURE IS A LEVER. Shortening exposure buys {spread:.1f} fps.")
            if auto_fps < fastest["fps"] - 3.0:
                print(f"  Auto-exposure is leaving {fastest['fps'] - auto_fps:.1f} fps on the "
                      f"table — it settled long for the light level. More light, or pin "
                      f"exposure to {fastest['requested']:g}.")
            print(f"  Trade-off: at {fastest['requested']:g} brightness is "
                  f"{fastest['brightness']:.0f}/255 vs {slowest['brightness']:.0f}/255 at "
                  f"{slowest['requested']:g}. Pick the shortest exposure still lit enough — "
                  f"shorter also means less motion blur on a moving barbell.")
        else:
            print(f"\n  EXPOSURE IS NOT THE BOTTLENECK. Rate is flat ({spread:.1f} fps) "
                  f"across the whole sweep, so the ceiling is elsewhere — "
                  f"re-run scripts/bench_uvc_capture.py and look at grab vs retrieve.")

    # Brightness swing is a verdict of its own: a camera can hold 60fps perfectly
    # while every frame lands at a different brightness. Frame rate cannot see that.
    swings = [(r["requested"], r["flicker"]["p2p_pct"]) for r in results
              if r.get("flicker") and r["flicker"]["p2p_pct"] == r["flicker"]["p2p_pct"]]
    if swings:
        worst_at, worst = max(swings, key=lambda pair: pair[1])
        where = f"exposure {worst_at:g}" if worst_at is not None else "auto exposure"
        print(f"\n  brightness swing: worst {worst:.1f}% peak-to-peak at {where}")
        if worst >= FLICKER_WARN_PCT:
            print(f"  FLICKERING. Above {FLICKER_WARN_PCT:.0f}% on a static scene this is a "
                  f"mains beat, not noise, and it grows as exposure shortens. Check that "
                  f"the sensor's anti-flicker filter matches local mains — on V4L2 "
                  f"uvc_devices.set_power_line_frequency() pins it to {MAINS_HZ}Hz. "
                  f"OpenCV cannot reach that control on Windows; set it in the vendor "
                  f"utility or the DirectShow property page.")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({
            "environment": environment_summary(api, decode_path),
            "config": {"index": index, "width": args.width, "height": args.height,
                       "fourcc": args.fourcc, "driver_fps": driver_fps,
                       "seconds_per_setting": args.seconds,
                       "platform_units": "log2 seconds (DSHOW)" if IS_WINDOWS else "100us (V4L2)"},
            "results": results,
        }, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
