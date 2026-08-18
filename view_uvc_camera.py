"""Live preview window for a physical UVC camera.

The eyeball check that everything downstream depends on — is the camera framed,
focused, exposed, and actually delivering frames at the rate it claims. The
on-frame overlay carries the numbers that matter while you are physically
aiming the camera, so you are not switching between a window and a terminal
with your hands on the rig.

Reported fps is the whole loop (capture + decode + draw + present), not the
sensor rate. When it sits below the driver's claim, that is expected — use
``bench_uvc_capture.py`` to attribute the gap to a stage.

Keys:
  q / ESC   quit
  s         save a full-resolution PNG snapshot (unannotated)
  space     pause / resume
  g         toggle grayscale (rough focus aid — edges are easier to judge)

Usage (from the repo root):
  uv run python view_uvc_camera.py                       # auto-pick AR0234
  uv run python view_uvc_camera.py --index 1 --width 1280 --height 800
  uv run python view_uvc_camera.py --fourcc YUY2 --out-dir tmp/uvc
"""

from __future__ import annotations

import argparse
import sys
from collections import deque
from pathlib import Path
from time import perf_counter

import cv2

ROOT = Path(__file__).resolve().parent

from uvc_devices import (
    FrameTimer,
    add_environment_args,
    backend_name,
    find_index,
    fourcc_of,
    index_probe_api,
    open_capture,
    print_summary,
    resolve_environment,
)

WINDOW = "UVC preview  [q/ESC quit  s snapshot  space pause  g gray]"


def draw_overlay(frame, lines: list[str]) -> None:
    """Outline-then-fill so the text stays readable over any scene brightness."""
    y = 44
    for text in lines:
        for colour, thickness in (((0, 0, 0), 5), ((0, 255, 0), 2)):
            cv2.putText(frame, text, (16, y), cv2.FONT_HERSHEY_SIMPLEX, 0.9, colour, thickness)
        y += 38


def main() -> int:
    parser = argparse.ArgumentParser(description="Live UVC camera preview")
    parser.add_argument("--index", type=int, default=None,
                        help="OpenCV camera index (default: auto-detect by resolution)")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1200)
    parser.add_argument("--fourcc", default="MJPG", choices=("MJPG", "YUY2"))
    parser.add_argument("--fps", type=int, default=60, help="requested driver fps")
    parser.add_argument("--display-width", type=int, default=1280,
                        help="window width; the capture stays full resolution")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "tmp" / "uvc",
                        help="snapshot destination")
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
                  f"run scripts/uvc_devices.py --modes to see what is available.",
                  file=sys.stderr)
            return 1
        print(f"auto-detected index {index} for {args.width}x{args.height}")

    cap = open_capture(index, args.width, args.height, args.fourcc, args.fps,
                       api=api, decode_path=decode_path)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    driver_fps = cap.get(cv2.CAP_PROP_FPS)
    print(f"opened index={index} via {backend_name(api)} decode_path={decode_path}  "
          f"{width}x{height} fourcc={fourcc_of(cap)!r} driver_fps={driver_fps:.0f}")

    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WINDOW, args.display_width, int(args.display_width * height / max(width, 1)))

    timer = FrameTimer()
    # Rate over a sliding window of arrival times — an EMA of instantaneous
    # rates is biased upward under jitter and overstates the loop rate.
    window: deque[float] = deque(maxlen=60)
    fps_now = 0.0
    paused = False
    grayscale = False
    saved = 0
    last_frame = None

    try:
        while True:
            if not paused:
                ok, frame = cap.read()
                if not ok:
                    print("frame grab failed — device may have been unplugged", file=sys.stderr)
                    break
                last_frame = frame
                timer.tick()
                window.append(perf_counter())
                if len(window) > 1 and window[-1] > window[0]:
                    fps_now = (len(window) - 1) / (window[-1] - window[0])

            if last_frame is None:
                continue

            view = last_frame.copy()
            if grayscale:
                view = cv2.cvtColor(cv2.cvtColor(view, cv2.COLOR_BGR2GRAY), cv2.COLOR_GRAY2BGR)
            draw_overlay(view, [
                f"{width}x{height} {args.fourcc}  driver {driver_fps:.0f} fps",
                f"loop {fps_now:5.1f} fps   frame {timer.frames}"
                + ("   [PAUSED]" if paused else ""),
            ])
            cv2.imshow(WINDOW, view)

            key = cv2.waitKey(1) & 0xFF
            if key in (ord("q"), 27):
                break
            if key == ord(" "):
                paused = not paused
            if key == ord("g"):
                grayscale = not grayscale
            if key == ord("s"):
                args.out_dir.mkdir(parents=True, exist_ok=True)
                path = args.out_dir / f"uvc_{width}x{height}_{saved:03d}.png"
                cv2.imwrite(str(path), last_frame)
                print(f"saved {path}")
                saved += 1
            # Catch the window's close button, which does not raise a key event.
            if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                break
    except KeyboardInterrupt:
        print("\ninterrupted")
    finally:
        cap.release()
        cv2.destroyAllWindows()

    print_summary("preview loop (capture + decode + draw + present)", timer.summary())
    print("\nthis is the whole loop, not the sensor rate. "
          "run scripts/bench_uvc_capture.py to split it per stage.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
