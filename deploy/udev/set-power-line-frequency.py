#!/usr/bin/env python3
"""Set a V4L2 device's anti-flicker filter to the local mains frequency.

Run by udev on every device add, so a replug or a reboot cannot silently return
the rig to the module's 50 Hz default. Standalone on purpose: udev runs this as
root, very early, with no virtualenv and no working directory to speak of, so it
imports nothing outside the standard library and never touches the repo.

Why it matters: these modules power up assuming 50 Hz mains. On 60 Hz the
mismatch shows up as frame-to-frame brightness swing that scales inversely with
exposure time, so it hides completely until auto-exposure happens to settle
short. Measured on this rig, one camera swung 39.1% peak-to-peak; the same
camera swung 2.4% once this control was set to 60 Hz.

Usage:
  set-power-line-frequency.py /dev/video0 60
"""

import fcntl
import struct
import sys

V4L2_CID_POWER_LINE_FREQUENCY = 0x00980918
VIDIOC_S_CTRL = 0xC008561C
VIDIOC_G_CTRL = 0xC008561B
MENU = {"disabled": 0, "50": 1, "60": 2}


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    node, mains = argv[1], argv[2]
    menu = MENU.get(mains)
    if menu is None:
        print(f"mains must be one of {sorted(MENU)}, got {mains!r}", file=sys.stderr)
        return 2

    try:
        with open(node, "rb+", buffering=0) as dev:
            for op, value in ((VIDIOC_S_CTRL, menu), (VIDIOC_G_CTRL, 0)):
                buf = bytearray(struct.pack("Ii", V4L2_CID_POWER_LINE_FREQUENCY, value))
                fcntl.ioctl(dev, op, buf, True)
            readback = struct.unpack("Ii", buf)[1]
    except OSError as exc:
        # Metadata nodes (the odd-numbered ones on these modules) carry no such
        # control. Failing loudly here would fill the journal on every plug.
        print(f"{node}: {exc}", file=sys.stderr)
        return 1

    if readback != menu:
        print(f"{node}: asked for menu {menu} ({mains}Hz), device reports {readback}",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
