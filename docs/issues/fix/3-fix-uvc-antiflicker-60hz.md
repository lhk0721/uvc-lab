# 3 fix: UVC anti-flicker를 60Hz로 맞추고 밝기 변동 지표 추가

## Summary
- Issue: #3
- Branch: `3-fix-uvc-antiflicker-60hz`
- Umbrella: #1
- Status: in progress

## Current State

Implemented, verified on the rig, and the udev rule is installed on the
Jetson. Not pushed, not merged. The Jetson's deployed copy at
`~/.uvc-lab/repo` still runs `main`; it does not need this branch, because the
udev rule fixes the devices themselves. Two unrelated defects found while
measuring are still open and unfiled: `Corrupt JPEG data` on hub port 3 only,
and delivered frame rates far below the requested 60 on all three cameras.

The DCXIN/DECXIN modules power up with `power_line_frequency = 50 Hz` (that is the
device default, on all three units). The rig runs on 60 Hz mains. The mismatch
shows up as frame-to-frame brightness swing, and it is invisible until
auto-exposure happens to settle on a short exposure — which is why one camera
looked broken while two identical ones looked fine.

Measured on the Jetson, MJPG 1280x720, auto-exposure, `uvc-lab.service` stopped so
nothing else held the devices:

| power_line_frequency | port2 (DCXIN) | port4 (DECXIN) | port3 (DCXIN) |
| --- | --- | --- | --- |
| 50 Hz (device default) | 6.9% | 4.6% | **39.1% @ 8.85 Hz** |
| 60 Hz | 1.7% | 0.2% | **2.4%** |

(peak-to-peak frame-brightness swing as a percentage of mean brightness)

Supporting evidence from the same camera on a Windows laptop: the module refused
every requested frame rate and delivered only 25.0 / 33.1 / 50.0 fps — exactly
100/4, 100/3 and 100/2, i.e. frame timing locked to submultiples of an assumed
100 Hz. Brightness swing scaled inversely with exposure time (3.9 ms -> 48%,
7.8 ms -> 28%, 15.6 ms -> 4.5%, 31.2 ms -> 0.6%).

Two things this work must not repeat:

- These modules persist UVC control values across unplug and across hosts. A
  manual exposure written during a laptop debugging session followed the camera
  onto the Jetson and was still set on arrival. Any tool that writes controls
  must restore them.
- On Windows/DirectShow OpenCV cannot reach `power_line_frequency` at all, so the
  fix is V4L2-only and the Windows path must say so rather than silently skip.

Known and deliberately out of scope here: `Corrupt JPEG data` errors appear on
hub port 3 only, and delivered frame rates across all three cameras sit far below
the requested 60. Neither is caused by the anti-flicker setting. File separately.

## Plan

1. `uvc_devices.py` — set `power_line_frequency` to 60 Hz when opening a V4L2
   device, via ioctl (no `v4l2-ctl` on the Jetson, and no new dependency).
   Report set vs read-back. No-op with an explanatory note on Windows.
2. `experiment_uvc_exposure.py` — report brightness standard deviation and
   peak-to-peak alongside the mean, and sample consecutive frames so temporal
   variation is actually visible.
3. `deploy/udev/` — a rule that re-applies the setting on every device add, so a
   replug or reboot does not silently return the rig to 50 Hz.

## fix: UVC anti-flicker를 60Hz로 맞추고 밝기 변동 지표 추가

What / why:

- `uvc_devices.set_power_line_frequency()` writes V4L2 `power_line_frequency`
  through the `set_control()` / `CONTROL_IDS` helpers #2 landed, which already
  read back what the driver kept. The first draft carried its own ioctl
  constants; rebasing onto the merged #2 made that a duplicate, so it was
  rewritten against the shared helpers. Not `v4l2-ctl`, because the Jetson does
  not have `v4l2-utils` and adding it needs sudo on every new machine.
  `open_capture()` calls it on Linux and warns on failure instead of aborting —
  a capture that flickers is still a capture, and refusing to open would be worse.
- Windows returns None and skips. OpenCV reaches this control through neither
  DirectShow nor MSMF, so pretending otherwise would be a silent no-op.
- `experiment_uvc_exposure.py` now reports brightness sd and peak-to-peak, and
  samples consecutive frames. The old every-fifth-frame sampling aliased exactly
  the oscillation this is meant to catch, so the script could not have found this
  bug no matter how it was run.
- `deploy/udev/` re-applies the setting on every device add. The control resets
  when the device re-enumerates, so a one-off write does not survive a replug.

How verified (Jetson Orin Nano, three modules on one USB3 hub, `uvc-lab.service`
stopped so nothing else held the devices; MJPG 1280x720, auto-exposure):

| power_line_frequency | port2 | port4 | port3 |
| --- | --- | --- | --- |
| 50 Hz | 6.9% | 4.6% | 39.1% @ 8.85 Hz |
| 60 Hz | 1.7% | 0.2% | 2.4% |

- `open_capture()` path: seeded the device back to 50 Hz, opened it, read the
  control back — 60 Hz, and frames still arrive. PASS.
- udev rule: seeded all three to 50 Hz, `udevadm trigger --action=add`, all three
  came back 60 Hz.
- udev helper edge cases: metadata node `/dev/video1` exits 1 with a message and
  no traceback; an unsupported mains value exits 2.
- Windows: `set_power_line_frequency()` returns None, both modules import.
