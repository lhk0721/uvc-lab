"""Experiment: multi-camera USB UVC synchronisation and bandwidth contention.

Two questions, both of which decide whether a multi-camera USB rig is viable:

1. **Skew.** Free-running UVC cameras have no phase lock. Each sensor runs its
   own clock and starts whenever it was opened, so at N fps the offset between
   two cameras' exposures is essentially uniform over a full frame period.
   This matters because triangulation assumes the views are simultaneous — if
   they are not, a moving joint is reconstructed from positions it held at
   different instants, and the error is a *bias along the direction of motion*,
   not noise that averaging removes. At 1.5 m/s (a brisk barbell) and 33 ms of
   skew, that is 5 cm of displacement between views. Our best measured pair
   accuracy is 2.87 cm, so unmanaged skew would dominate the entire
   error budget.

2. **Contention.** N cameras share host USB bandwidth. Cameras that each hold
   60 fps alone may collapse when run together, and the collapse is what
   determines how many cameras a single host controller can carry.

Method, and one wrong turn worth recording. The obvious approach — call
``grab()`` on each camera in a round and take the spread of return times — is
invalid on DirectShow, where ``grab()`` does not block. It returns immediately
for every camera and yields a skew of ~0.0 ms, which reads as "these cameras
are perfectly synchronised" when nothing was measured at all.

So each camera is instead read on its own thread, where ``read()`` genuinely
blocks until a frame arrives, and every arrival is timestamped. Frames are then
paired across cameras by nearest timestamp — which is what a synthesis
pipeline would do anyway — and the residual time difference of those pairs is
the skew that actually reaches triangulation.

What this still does NOT measure: the exposure instant. Arrival timestamps sit
downstream of transfer and decode, so they are an upper bound. Ground truth
needs an event visible to every camera at once. ``--flash-check`` does that:
point all cameras at one blinking source and the script reports the frame
offset at which each sees the transition.

Usage (from the repo root):
  uv run python experiment_uvc_sync.py --indices 0 1
  uv run python experiment_uvc_sync.py --indices 0 1 --width 1280 --height 720
  uv run python experiment_uvc_sync.py --indices 0 1 --flash-check
"""

from __future__ import annotations

import argparse
import bisect
import json
import statistics
import sys
import threading
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np

from uvc_devices import (
    FrameTimer,
    add_environment_args,
    backend_name,
    environment_summary,
    open_capture,
    print_summary,
    resolve_environment,
)

WARMUP_FRAMES = 15
# Speeds to translate skew into a positional error the project can weigh.
REFERENCE_SPEEDS_MPS = (0.5, 1.0, 1.5, 2.0)
BEST_PAIR_MPJPE_CM = 2.87  # #95 best measured pair accuracy, for comparison


def measure_solo(index: int, width: int, height: int, fourcc: str,
                 fps: int, seconds: float, api: int | None = None,
                 decode_path: str | None = None) -> dict:
    cap = open_capture(index, width, height, fourcc, fps,
                       api=api, decode_path=decode_path)
    for _ in range(WARMUP_FRAMES):
        cap.read()
    timer = FrameTimer()
    deadline = perf_counter() + seconds
    while perf_counter() < deadline:
        if not cap.read()[0]:
            break
        timer.tick()
    cap.release()
    return timer.summary()


def _capture_worker(cap: cv2.VideoCapture, seconds: float,
                    arrivals: list[float], timer: FrameTimer) -> None:
    """Blocking reads on one camera, timestamping every arrival.

    Runs on its own thread so each camera's read() blocks independently;
    serialising them would make one camera's latency show up as another's skew.
    OpenCV releases the GIL inside read(), so these really do overlap.
    """
    deadline = perf_counter() + seconds
    while perf_counter() < deadline:
        ok, _frame = cap.read()
        if not ok:
            break
        arrivals.append(perf_counter())
        timer.tick()


def _nearest_pair_skews(a: list[float], b: list[float]) -> list[float]:
    """For each frame of ``a``, the gap to the closest frame of ``b``.

    Nearest-timestamp pairing is what a synthesis pipeline does when it matches
    views, so this is the skew that actually survives into triangulation —
    not the raw offset between two arbitrary frame indices.
    """
    if not a or not b:
        return []
    out = []
    for t in a:
        i = bisect.bisect_left(b, t)
        candidates = [b[j] for j in (i - 1, i) if 0 <= j < len(b)]
        if candidates:
            out.append(min(abs(t - c) for c in candidates))
    return out


def measure_concurrent(caps: list[cv2.VideoCapture], seconds: float) -> dict:
    """Per-camera rate under contention, plus real arrival skew between cameras."""
    for cap in caps:
        for _ in range(WARMUP_FRAMES):
            cap.read()

    timers = [FrameTimer() for _ in caps]
    arrivals: list[list[float]] = [[] for _ in caps]
    threads = [
        threading.Thread(target=_capture_worker, args=(cap, seconds, arrivals[i], timers[i]),
                         daemon=True)
        for i, cap in enumerate(caps)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=seconds + 15)

    pairwise = {}
    for i in range(len(caps)):
        for j in range(i + 1, len(caps)):
            skews = _nearest_pair_skews(sorted(arrivals[i]), sorted(arrivals[j]))
            pairwise[f"{i}-{j}"] = _skew_stats(skews)

    return {
        "frames_per_camera": [len(a) for a in arrivals],
        "per_camera": [t.summary() for t in timers],
        "pairwise_skew_ms": pairwise,
    }


def _skew_stats(values: list[float]) -> dict:
    if not values:
        return {}
    ms = sorted(v * 1000.0 for v in values)
    return {
        "mean": round(sum(ms) / len(ms), 2),
        "p50": round(statistics.median(ms), 2),
        "p95": round(ms[min(len(ms) - 1, int(len(ms) * 0.95))], 2),
        "max": round(ms[-1], 2),
        "samples": len(ms),
    }


def flash_check(caps: list[cv2.VideoCapture], frames: int) -> dict:
    """Frame index at which each camera first sees a large brightness jump.

    Point every camera at one blinking light. A shared physical event is the
    only way to compare cameras on a common time base — host timestamps cannot
    see when the sensor actually integrated.
    """
    series: list[list[float]] = [[] for _ in caps]
    for _ in range(frames):
        for cap in caps:
            cap.grab()
        for i, cap in enumerate(caps):
            ok, frame = cap.retrieve()
            series[i].append(float(np.mean(frame[::8, ::8])) if ok and frame is not None else float("nan"))

    transitions = []
    for i, values in enumerate(series):
        arr = np.array(values, dtype=float)
        if np.all(np.isnan(arr)) or len(arr) < 3:
            transitions.append(None)
            continue
        diffs = np.abs(np.diff(arr))
        threshold = np.nanmean(diffs) + 3 * np.nanstd(diffs)
        hits = np.where(diffs > max(threshold, 2.0))[0]
        transitions.append(int(hits[0]) if len(hits) else None)

    found = [t for t in transitions if t is not None]
    return {
        "per_camera_first_transition_frame": transitions,
        "frame_offset_spread": (max(found) - min(found)) if len(found) > 1 else None,
        "note": ("no brightness transition detected — is the light actually blinking, "
                 "and in view of every camera?") if len(found) < len(caps) else "",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Multi-camera UVC sync and contention")
    parser.add_argument("--indices", type=int, nargs="+", required=True,
                        help="camera indices to run together, e.g. --indices 0 1")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fourcc", default="MJPG", choices=("MJPG", "YUY2"))
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--seconds", type=float, default=10.0)
    parser.add_argument("--skip-solo", action="store_true",
                        help="skip the per-camera baseline (halves runtime)")
    parser.add_argument("--flash-check", action="store_true",
                        help="LED-strobe sync check (point all cameras at a blinking light)")
    parser.add_argument("--json", type=Path, default=None)
    add_environment_args(parser)
    args = parser.parse_args()

    if len(args.indices) < 2:
        print("need at least two indices", file=sys.stderr)
        return 1

    try:
        api, decode_path = resolve_environment(args)
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1

    print(f"cameras {args.indices}  backend={backend_name(api)}  "
          f"decode_path={decode_path}  "
          f"{args.width}x{args.height} {args.fourcc} @{args.fps}\n")

    solo = {}
    if not args.skip_solo:
        print("[1/2] solo baseline — each camera alone")
        for index in args.indices:
            summary = measure_solo(index, args.width, args.height,
                                   args.fourcc, args.fps, args.seconds,
                                   api=api, decode_path=decode_path)
            solo[index] = summary
            print(f"  index {index}: {summary.get('mean_fps', 0):.1f} fps")
    else:
        print("[1/2] solo baseline skipped")

    print(f"\n[2/2] concurrent — all {len(args.indices)} together")
    caps = []
    try:
        for index in args.indices:
            caps.append(open_capture(index, args.width, args.height, args.fourcc,
                                     args.fps, api=api, decode_path=decode_path))
    except RuntimeError as exc:
        for cap in caps:
            cap.release()
        print(f"  {exc}", file=sys.stderr)
        print("  opening several UVC cameras at once can exceed a controller's bandwidth. "
              "Try a lower resolution, or move a camera to a different host controller.",
              file=sys.stderr)
        return 1

    concurrent = measure_concurrent(caps, args.seconds)
    flash = flash_check(caps, 120) if args.flash_check else None
    for cap in caps:
        cap.release()

    for i, index in enumerate(args.indices):
        summary = concurrent["per_camera"][i]
        line = f"  index {index}: {summary.get('mean_fps', 0):.1f} fps"
        if index in solo:
            alone = solo[index].get("mean_fps", 0.0)
            together = summary.get("mean_fps", 0.0)
            drop = (1 - together / alone) * 100 if alone else 0.0
            line += f"   (solo {alone:.1f} -> {drop:+.0f}%)"
        print(line)

    print("\n" + "=" * 72)
    print("SKEW (thread-timed frame arrivals, paired by nearest timestamp)")
    print("=" * 72)
    period_ms = 1000.0 / args.fps
    print(f"  frame period at {args.fps} fps is {period_ms:.1f} ms. Free-running cameras "
          f"have no phase lock,\n  so pairing error is bounded by half a period "
          f"({period_ms / 2:.1f} ms) at best.")

    worst_p95 = 0.0
    for pair, skew in concurrent["pairwise_skew_ms"].items():
        if not skew:
            print(f"\n  cameras {pair}: no overlapping frames captured")
            continue
        left, right = pair.split("-")
        print(f"\n  cameras {args.indices[int(left)]} <-> {args.indices[int(right)]}:  "
              f"p50 {skew['p50']} ms   p95 {skew['p95']} ms   max {skew['max']} ms "
              f"({skew['samples']} pairs)")
        worst_p95 = max(worst_p95, skew["p95"])

    if worst_p95:
        print(f"\n  positional error implied by the worst p95 ({worst_p95:.1f} ms):")
        for speed in REFERENCE_SPEEDS_MPS:
            cm = speed * (worst_p95 / 1000.0) * 100
            verdict = "EXCEEDS" if cm > BEST_PAIR_MPJPE_CM else "under"
            print(f"    {speed:>4.1f} m/s -> {cm:>6.2f} cm  ({verdict} the "
                  f"{BEST_PAIR_MPJPE_CM} cm best-pair accuracy from #95)")
        print("\n  Skew displaces a moving joint along its direction of travel, so it is a")
        print("  bias, not noise — averaging over frames will not remove it.")
        print("  Arrival timestamps sit after transfer and decode, so treat this as an")
        print("  upper bound; --flash-check is the ground-truth measurement.")

    if flash:
        print("\n" + "=" * 72)
        print("FLASH CHECK (shared physical event)")
        print("=" * 72)
        print(f"  first transition frame per camera: "
              f"{flash['per_camera_first_transition_frame']}")
        if flash["frame_offset_spread"] is not None:
            print(f"  spread: {flash['frame_offset_spread']} frames "
                  f"(~{flash['frame_offset_spread'] * 1000.0 / args.fps:.1f} ms)")
        if flash["note"]:
            print(f"  {flash['note']}")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({
            "environment": environment_summary(api, decode_path),
            "config": {"indices": args.indices, "width": args.width, "height": args.height,
                       "fourcc": args.fourcc, "fps": args.fps, "seconds": args.seconds},
            "solo": {str(k): v for k, v in solo.items()},
            "concurrent": concurrent,
            "flash_check": flash,
        }, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
