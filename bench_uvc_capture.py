"""Stage-attributed capture benchmark for a physical UVC camera.

Question: the driver advertises 60 fps at 1920x1200 but the first preview loop
measured 41.9. Where do the missing frames go? A single end-to-end number
cannot say, and the candidates need different fixes:

  transfer / sensor   the frame is not arriving in time — bandwidth, a shared
                      controller, or long auto-exposure integration.
                      Fix: mode, cabling, port topology, exposure.
  decode              the frame arrives but costs CPU to unpack (MJPG).
                      Fix: YUY2, hardware decode, or decode off the hot path.
  present / draw      only a preview pays this; a headless feed does not.
                      Fix: ignore it, or draw less often.

A note on method, learned the hard way. The obvious split is to time ``grab()``
and ``retrieve()`` separately and call the first "transfer" and the second
"decode". **That does not hold on DirectShow**, where ``grab()`` returns
immediately without waiting for a new frame (measured: 0.0 ms p50, and a
grab-only loop spinning at >600k fps) and ``retrieve()`` blocks for the frame
*and* decodes it. Reading the split naively yields a confident "decode bound"
verdict that is simply an artefact of which call happens to block.

So this script measures which call blocks before interpreting anything, and
isolates decode cost independently: it re-encodes a captured frame to JPEG and
times ``imdecode`` on it. That is a CPU cost, comparable against the frame
period, and it does not care which backend blocks where.

The stages:
  read               transfer + decode — what a headless inference feed pays.
                     This is the number that matters for the pipeline.
  read + display     adds present — what a preview window pays.
  decode micro       imdecode cost alone, for attribution.

Usage (from the repo root):
  uv run python bench_uvc_capture.py
  uv run python bench_uvc_capture.py --seconds 20 --fourcc YUY2
  uv run python bench_uvc_capture.py --width 1280 --height 720 --json tmp/benchmarks/uvc.json
  uv run python bench_uvc_capture.py --decode-path nvjpg   # Jetson: hardware JPEG arm
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from pathlib import Path
from time import perf_counter

import cv2

from uvc_devices import (
    FrameTimer,
    add_environment_args,
    backend_name,
    describe_signal,
    environment_summary,
    find_index,
    fourcc_of,
    frame_signal,
    index_probe_api,
    open_capture,
    print_summary,
    resolve_environment,
)

WARMUP_FRAMES = 15  # auto-exposure and the driver pipeline both need to settle
DECODE_SAMPLES = 60


def _stats_ms(values: list[float]) -> dict:
    if not values:
        return {}
    ms = sorted(v * 1000.0 for v in values)
    return {
        "mean": round(sum(ms) / len(ms), 3),
        "p50": round(statistics.median(ms), 3),
        "p95": round(ms[min(len(ms) - 1, int(len(ms) * 0.95))], 3),
        "max": round(ms[-1], 3),
    }


def warmup(cap: cv2.VideoCapture, frames: int = WARMUP_FRAMES) -> None:
    for _ in range(frames):
        cap.read()


def probe_blocking_call(cap: cv2.VideoCapture, driver_fps: float,
                        samples: int = 60) -> dict:
    """Which of grab()/retrieve() actually waits for the next frame.

    Without this, every downstream interpretation is backend-dependent
    folklore. Whichever call sits near the frame period is the one absorbing
    the wait; the other is doing real work only.
    """
    warmup(cap)
    grab_times, retrieve_times = [], []
    for _ in range(samples):
        t0 = perf_counter()
        if not cap.grab():
            break
        t1 = perf_counter()
        if not cap.retrieve()[0]:
            break
        t2 = perf_counter()
        grab_times.append(t1 - t0)
        retrieve_times.append(t2 - t1)

    grab = _stats_ms(grab_times)
    retrieve = _stats_ms(retrieve_times)
    period_ms = 1000.0 / driver_fps if driver_fps > 0 else 0.0
    # "Blocking" means sitting at a meaningful fraction of the frame period.
    threshold = period_ms * 0.5 if period_ms else 1.0
    which = "grab" if grab.get("p50", 0) > threshold else (
        "retrieve" if retrieve.get("p50", 0) > threshold else "neither")
    return {"grab_ms": grab, "retrieve_ms": retrieve,
            "blocking_call": which, "frame_period_ms": round(period_ms, 2)}


def bench_read(cap: cv2.VideoCapture, seconds: float) -> dict:
    """Transfer + decode — what a headless inference feed actually pays."""
    warmup(cap)
    timer = FrameTimer()
    deadline = perf_counter() + seconds
    while perf_counter() < deadline:
        if not cap.read()[0]:
            break
        timer.tick()
    return timer.summary()


def bench_read_display(cap: cv2.VideoCapture, seconds: float) -> dict:
    """Transfer + decode + present — what the preview window pays."""
    warmup(cap)
    window = "bench (closes automatically)"
    cv2.namedWindow(window, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(window, 960, 600)
    timer = FrameTimer()
    deadline = perf_counter() + seconds
    try:
        while perf_counter() < deadline:
            ok, frame = cap.read()
            if not ok:
                break
            cv2.imshow(window, frame)
            cv2.waitKey(1)
            timer.tick()
    finally:
        cv2.destroyWindow(window)
        cv2.waitKey(1)
    return timer.summary()


def bench_decode(cap: cv2.VideoCapture, samples: int = DECODE_SAMPLES) -> dict:
    """Decode cost in isolation, independent of which call blocks.

    Re-encoding a real frame to JPEG at the capture resolution reproduces the
    work an MJPG stream imposes, and timing imdecode on it gives a pure CPU
    number to compare against the frame period.
    """
    ok, frame = cap.read()
    if not ok or frame is None:
        return {}
    encoded_ok, buffer = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    if not encoded_ok:
        return {}
    times = []
    for _ in range(samples):
        t0 = perf_counter()
        cv2.imdecode(buffer, cv2.IMREAD_COLOR)
        times.append(perf_counter() - t0)
    return {**_stats_ms(times), "jpeg_kb": round(len(buffer) / 1024, 1)}


def interpret(blocking: dict, read: dict, display: dict | None,
              decode: dict, driver_fps: float, decode_path: str = "cpu") -> list[str]:
    """Turn the measurements into the sentence the operator needs."""
    notes = []
    period = blocking.get("frame_period_ms", 0.0)
    read_fps = read.get("mean_fps", 0.0)
    which = blocking.get("blocking_call", "neither")

    notes.append(
        f"the blocking call on this backend is {which}() — "
        f"grab p50 {blocking['grab_ms'].get('p50', 0):.1f}ms, "
        f"retrieve p50 {blocking['retrieve_ms'].get('p50', 0):.1f}ms, "
        f"frame period {period:.1f}ms. Transfer and decode cannot be split by "
        f"timing those two calls; the decode microbenchmark below does it instead."
    )

    decode_p50 = decode.get("p50", 0.0)
    decode_is_a_cause = False
    if decode_p50 and decode_path == "nvjpg":
        # The CPU is not decoding on this path, so the imdecode figure must not
        # feed a decode-bound verdict — it is the cost being avoided.
        notes.append(
            f"decode runs on NVJPG hardware; the imdecode p50 {decode_p50:.1f}ms is the "
            f"per-frame CPU cost this path avoids, not a cost being paid. If read() "
            f"still misses the rate, the cause is transfer or the pipeline, not decode."
        )
    elif decode_p50 and period:
        headroom = period / decode_p50
        # Share of the frame time actually achieved, which is the honest
        # measure: consuming most of a budget you are already missing is a
        # cause even when it technically fits inside the nominal period.
        achieved_ms = 1000.0 / read_fps if read_fps else 0.0
        share = decode_p50 / achieved_ms if achieved_ms else 0.0
        if decode_p50 >= period:
            decode_is_a_cause = True
            notes.append(
                f"DECODE BOUND: decoding one frame costs {decode_p50:.1f}ms, at or beyond "
                f"the {period:.1f}ms frame period. The CPU cannot keep up at "
                f"{driver_fps:.0f} fps — try YUY2, or move decode off the hot path."
            )
        elif headroom < 1.5 or share > 0.5:
            decode_is_a_cause = True
            notes.append(
                f"DECODE IS A MAJOR COST: {decode_p50:.1f}ms/frame is {share * 100:.0f}% of "
                f"the {achieved_ms:.1f}ms you are actually achieving, and only "
                f"{headroom:.1f}x inside the {period:.1f}ms period. It leaves nothing for "
                f"inference — compare against the other pixel format before blaming the bus."
            )
        else:
            notes.append(
                f"decode costs {decode_p50:.1f}ms/frame against a {period:.1f}ms period "
                f"({headroom:.1f}x headroom, {share * 100:.0f}% of achieved frame time) "
                f"— not the bottleneck."
            )
        notes.append(
            "decode figure is approximate: it re-encodes a captured frame at JPEG q90 "
            "rather than timing the camera's own bitstream, and it competes with the "
            "live capture for CPU."
        )

    if driver_fps and read_fps >= driver_fps * 0.95:
        notes.append(
            f"CAPTURE PATH IS CLEAN: read() sustains {read_fps:.1f} fps against an "
            f"advertised {driver_fps:.0f}. The camera and the transfer are fine, and a "
            f"headless inference feed gets the full rate."
        )
    elif driver_fps and decode_is_a_cause:
        notes.append(
            f"read() sustains {read_fps:.1f} fps of the advertised {driver_fps:.0f}, and "
            f"decode above is a large part of that gap. Re-run with the other --fourcc "
            f"before investigating the bus."
        )
    elif driver_fps:
        notes.append(
            f"TRANSFER/SENSOR BOUND: read() sustains only {read_fps:.1f} fps of the "
            f"advertised {driver_fps:.0f}, and decode is not the cause. Suspect USB "
            f"bandwidth, a shared controller, or long auto-exposure integration — "
            f"run scripts/experiment_uvc_exposure.py to rule exposure in or out."
        )

    if display:
        display_fps = display.get("mean_fps", 0.0)
        if read_fps and display_fps:
            cost_ms = (1000.0 / display_fps) - (1000.0 / read_fps)
            notes.append(
                f"presenting costs {cost_ms:.1f}ms/frame ({read_fps:.1f} -> "
                f"{display_fps:.1f} fps). This is a preview-only cost — do not read it "
                f"as a camera limit."
            )
    return notes


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage-attributed UVC capture benchmark")
    parser.add_argument("--index", type=int, default=None)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1200)
    parser.add_argument("--fourcc", default="MJPG", choices=("MJPG", "YUY2"))
    parser.add_argument("--fps", type=int, default=60, help="requested driver fps")
    parser.add_argument("--seconds", type=float, default=10.0, help="duration per stage")
    parser.add_argument("--no-display", action="store_true",
                        help="skip the display stage (headless machines)")
    parser.add_argument("--json", type=Path, default=None, help="write results as JSON")
    add_environment_args(parser)
    args = parser.parse_args()

    try:
        api, decode_path = resolve_environment(args)
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1

    index = args.index
    if index is None:
        index = find_index((args.width, args.height), api=index_probe_api(api))
        if index is None:
            print(f"no camera supports {args.width}x{args.height}. "
                  f"run uvc_devices.py --modes first.", file=sys.stderr)
            return 1
        print(f"auto-detected index {index}")

    cap = open_capture(index, args.width, args.height, args.fourcc, args.fps,
                       api=api, decode_path=decode_path)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    actual_fourcc = fourcc_of(cap)
    driver_fps = cap.get(cv2.CAP_PROP_FPS)

    print(f"index={index} backend={backend_name(api)} decode_path={decode_path} "
          f"{width}x{height} fourcc={actual_fourcc!r} driver_fps={driver_fps:.0f}")
    print(f"each stage runs {args.seconds:.0f}s after {WARMUP_FRAMES} warmup frames")

    # Before timing anything, confirm the frames contain an image. Rates
    # measured on null buffers look excellent and mean nothing.
    warmup(cap, 30)
    signal = frame_signal(cap.read()[1])
    print(f"signal check: {describe_signal(signal)}")
    if signal["state"] != "ok":
        print("  ^ every number below is measured on frames without a usable image.",
              file=sys.stderr)
    print()

    print("[1/4] which call blocks?")
    blocking = probe_blocking_call(cap, driver_fps)
    print(f"  grab      {blocking['grab_ms']}")
    print(f"  retrieve  {blocking['retrieve_ms']}")
    print(f"  -> {blocking['blocking_call']}() absorbs the wait "
          f"(frame period {blocking['frame_period_ms']}ms)")

    print("\n[2/4] read (transfer + decode — the headless inference feed)")
    read = bench_read(cap, args.seconds)
    print_summary("  read", read)

    display = None
    if not args.no_display:
        print("\n[3/4] read + display (what a preview window pays)")
        display = bench_read_display(cap, args.seconds)
        print_summary("  read+display", display)
    else:
        print("\n[3/4] skipped (--no-display)")

    print(f"\n[4/4] decode cost in isolation ({DECODE_SAMPLES} imdecode samples)")
    decode = bench_decode(cap)
    if decode:
        print(f"  imdecode  p50 {decode['p50']}ms  p95 {decode['p95']}ms  "
              f"(jpeg {decode['jpeg_kb']} KB)")
    else:
        print("  unavailable")

    cap.release()

    print("\n" + "=" * 76)
    print("ATTRIBUTION")
    print("=" * 76)
    rows = [("read (transfer+decode)", read)]
    if display:
        rows.append(("read + display", display))
    for label, res in rows:
        print(f"  {label:<24} {res.get('mean_fps', 0.0):>7.1f} fps")
    print()
    if signal["state"] != "ok":
        print(f"  !! SIGNAL: {describe_signal(signal)}")
        print("     Fix the image before trusting any rate below — a mode that streams "
              "nothing is not a fast mode.\n")
    for note in interpret(blocking, read, display, decode, driver_fps, decode_path):
        print(f"  - {note}")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({
            "environment": environment_summary(api, decode_path),
            "config": {
                "index": index, "width": width, "height": height,
                "requested_fourcc": args.fourcc, "actual_fourcc": actual_fourcc,
                "requested_fps": args.fps, "driver_fps": driver_fps,
                "seconds_per_stage": args.seconds,
            },
            "signal": signal,
            "blocking_probe": blocking,
            "read": read,
            "read_display": display,
            "decode_micro": decode,
        }, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
