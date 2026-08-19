"""UVC device identification and shared capture helpers.

Problem this solves: OpenCV addresses cameras by bare integer index and neither
DirectShow nor MSMF exposes a device name through the ``VideoCapture`` API. So
"index 1" tells you nothing about *which* physical camera you opened — on a
laptop with a built-in webcam plus a USB module, the mapping is guesswork and it
reshuffles when you replug.

Two mapping strategies, picked per platform:

  Linux (Jetson)  ``/sys/class/video4linux/videoN/name`` gives the name for
                  index N directly. The mapping is exact.
  Windows         The OS knows the names (PnP) and OpenCV knows the indices,
                  but nothing joins them. We probe each index for its supported
                  mode set and match on the *capability signature* instead —
                  max resolution and aspect ratio. An AR0234 is 1920x1200
                  (16:10, 2.3MP global shutter); a typical webcam tops out at
                  1920x1080 (16:9), so the two separate cleanly. Name
                  attribution from PnP enumeration order is a HEURISTIC and is
                  reported as such — trust the signature, not the name.

Also the shared bits every other script here needs: backend selection, mode
setting, and ``FrameTimer`` (interval percentiles + dropped-frame detection,
because a mean fps hides both jitter and gaps).

Usage (from the repo root):
  uv run python uvc_devices.py                 # identify open indices
  uv run python uvc_devices.py --modes         # + probe supported modes (slow)
  uv run python uvc_devices.py --max-index 8
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import statistics
import struct
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from time import perf_counter

import cv2
import numpy as np

IS_WINDOWS = platform.system() == "Windows"
IS_LINUX = platform.system() == "Linux"

# Probed low-to-high; the highest that survives becomes the capability signature.
# 16:10 entries are what separate an AR0234-class sensor from a 16:9 webcam.
MODE_CANDIDATES = (
    (640, 360),
    (640, 400),
    (640, 480),
    (1280, 720),
    (1280, 800),
    (1600, 1200),
    (1920, 1080),
    (1920, 1200),
)

FOURCC_CANDIDATES = ("MJPG", "YUY2")

# Measured on this rig (DSHOW, AR0234): CAP_PROP_FOURCC must be set LAST.
# Setting frame size or fps *after* it silently reverts the format to YUY2 —
# the set() call returns success and only the read-back reveals it. Getting
# this wrong makes every MJPG-vs-YUY2 comparison a YUY2-vs-YUY2 comparison.
#   fourcc -> size          -> YUY2   (reverted)
#   size -> fourcc -> fps   -> YUY2   (reverted)
#   size -> fps -> fourcc   -> MJPG   (correct)
FOURCC_MUST_BE_SET_LAST = True

# Native max resolution -> sensor family. Used to name a device from what it can
# actually do, which survives replugging and index reshuffles.
SIGNATURES = {
    (1920, 1200): "AR0234-class (2.3MP 16:10, global shutter candidate)",
    (1920, 1080): "generic FHD webcam (16:9)",
    (1280, 720): "generic HD webcam (16:9)",
}


def default_backend() -> int:
    """DirectShow on Windows (MSMF opens ~10x slower here), V4L2 on Linux."""
    if IS_WINDOWS:
        return cv2.CAP_DSHOW
    if IS_LINUX:
        return cv2.CAP_V4L2
    return cv2.CAP_ANY


def backend_name(api: int) -> str:
    return {
        cv2.CAP_DSHOW: "DSHOW",
        cv2.CAP_MSMF: "MSMF",
        cv2.CAP_V4L2: "V4L2",
        cv2.CAP_GSTREAMER: "GSTREAMER",
        cv2.CAP_ANY: "ANY",
    }.get(api, str(api))


# Every measurement script takes the same two environment switches, because the
# dev box (Windows/DSHOW, CPU decode) and the deployment target (Jetson/V4L2,
# NVJPG hardware decode) are different machines with different fast paths. A
# number measured on one must never be read as a property of the other; these
# options make each environment's real path measurable with the same command.
BACKEND_CHOICES = ("auto", "dshow", "msmf", "v4l2", "gstreamer")
DECODE_PATH_CHOICES = ("auto", "cpu", "nvjpg")


def resolve_backend(name: str) -> int:
    if name == "auto":
        return default_backend()
    return {
        "dshow": cv2.CAP_DSHOW,
        "msmf": cv2.CAP_MSMF,
        "v4l2": cv2.CAP_V4L2,
        "gstreamer": cv2.CAP_GSTREAMER,
    }[name]


def gstreamer_available() -> bool:
    """Whether this OpenCV build can open GStreamer pipelines at all.

    The pip ``opencv-python`` wheel on Windows ships without GStreamer, so a
    pipeline open would fail with an unrelated-looking error. Checking the
    build info up front turns that into a clear diagnosis.
    """
    for line in cv2.getBuildInformation().splitlines():
        if "GStreamer" in line and ":" in line:
            return "YES" in line.split(":", 1)[1]
    return False


def add_environment_args(parser) -> None:
    """The shared --backend / --decode-path switches (see BACKEND_CHOICES)."""
    parser.add_argument("--backend", choices=BACKEND_CHOICES, default="auto",
                        help="capture backend; auto = DSHOW on Windows, V4L2 on Linux. "
                             "'gstreamer' opens a v4l2src pipeline (Linux only)")
    parser.add_argument("--decode-path", choices=DECODE_PATH_CHOICES, default="auto",
                        help="who decodes MJPG: cpu (what cv2.VideoCapture always does) or "
                             "nvjpg (Jetson's hardware JPEG engine via GStreamer — the "
                             "deployment path). auto = cpu for now")


def resolve_environment(args) -> tuple[int, str]:
    """(api, decode_path) from parsed args, failing fast where the combination
    cannot produce a valid measurement on this machine."""
    api = resolve_backend(args.backend)
    decode_path = "cpu" if args.decode_path == "auto" else args.decode_path
    if decode_path == "nvjpg":
        if args.backend not in ("auto", "gstreamer"):
            raise RuntimeError(
                f"--decode-path nvjpg runs inside a GStreamer pipeline and cannot "
                f"combine with --backend {args.backend}")
        api = cv2.CAP_GSTREAMER
    if api == cv2.CAP_GSTREAMER:
        if not IS_LINUX:
            raise RuntimeError(
                "the gstreamer/nvjpg capture path needs Linux (v4l2src); the Windows "
                "opencv-python wheel has no GStreamer build. This is the deployment "
                "path — run the same command on the Jetson. Numbers measured here via "
                "the CPU path do not transfer to it.")
        if not gstreamer_available():
            raise RuntimeError(
                "this OpenCV build has no GStreamer support (see "
                "cv2.getBuildInformation()). On Jetson, use the system OpenCV or a "
                "GStreamer-enabled build.")
    return api, decode_path


def index_probe_api(api: int) -> int:
    """Backend usable for index probing (find_index / list_devices).

    A GStreamer pipeline needs explicit caps, not a bare index, so probing
    falls back to the classic platform backend and only the measured capture
    itself goes through the pipeline.
    """
    return default_backend() if api == cv2.CAP_GSTREAMER else api


def environment_summary(api: int | None = None, decode_path: str = "auto") -> dict:
    """Provenance block for result JSONs — which machine and capture path
    produced these numbers. Without it, dev-box and Jetson results are
    indistinguishable files a week later."""
    api = default_backend() if api is None else api
    return {
        "platform": platform.system(),
        "machine": platform.machine(),
        "opencv": cv2.__version__,
        "backend": backend_name(api),
        "decode_path": "cpu" if decode_path == "auto" else decode_path,
    }


# Process-wide fallbacks for open_capture(api=None, decode_path=None). The lab
# server sets these once from its CLI so every preset — which calls
# open_capture from many places — measures the requested path without each
# call site threading the parameters through.
_CAPTURE_DEFAULTS: dict = {"api": None, "decode_path": "cpu"}


def set_capture_defaults(api: int | None = None, decode_path: str | None = None) -> None:
    if api is not None:
        _CAPTURE_DEFAULTS["api"] = api
    if decode_path is not None:
        _CAPTURE_DEFAULTS["decode_path"] = "cpu" if decode_path == "auto" else decode_path


# An all-zero frame means no usable data, but NOT necessarily a broken device.
# Learned the hard way on this rig: with the lens cap on, YUY2 reported exactly
# zero everywhere and looked like a dead format, while MJPG on the same black
# scene showed small nonzero values — JPEG's DCT leaves ringing around flat
# black, uncompressed formats do not. The lens cap, not the format, was the
# fault. So treat "all zero" as "check the light path first", not as a verdict
# about the pixel format.
DEAD_MAX_LEVEL = 0
# Real signal but too dark to use — a partly blocked lens, an unlit room, or a
# pinned minimum exposure all land here.
DARK_MAX_LEVEL = 16
# The first frames after opening are null buffers on this backend (frame 0 is
# reliably all-zero, real signal appears by frame ~5). Anything sampling image
# content must discard them or it will diagnose a working camera as dead.
SETTLE_FRAMES = 10


def frame_signal(frame) -> dict:
    """Whether a frame actually carries an image.

    ``read()`` returning True only means a buffer arrived, not that anything
    is in it. Every measurement in these scripts is meaningless on null
    frames, so the content gets checked rather than assumed.
    """
    if frame is None or frame.size == 0:
        return {"state": "none", "min": 0, "max": 0, "mean": 0.0, "nonzero_pct": 0.0}
    peak = int(frame.max())
    state = "dead" if peak <= DEAD_MAX_LEVEL else ("dark" if peak < DARK_MAX_LEVEL else "ok")
    return {
        "state": state,
        "min": int(frame.min()),
        "max": peak,
        "mean": round(float(frame.mean()), 2),
        "nonzero_pct": round(100.0 * float(np.count_nonzero(frame)) / frame.size, 1),
    }


def describe_signal(signal: dict) -> str:
    if signal["state"] == "dead":
        return ("DEAD — every pixel is 0. No usable image: check the lens cap and lighting "
                "first (a capped uncompressed stream reads exactly zero). Any rate measured "
                "here counts frames without an image.")
    if signal["state"] == "dark":
        return (f"DARK — peak pixel {signal['max']}/255, mean {signal['mean']}. There is "
                f"signal but no usable image: check the lens cap, the lighting, and exposure.")
    return f"ok — mean {signal['mean']}/255, peak {signal['max']}"


def fourcc_of(cap: cv2.VideoCapture) -> str:
    raw = int(cap.get(cv2.CAP_PROP_FOURCC))
    chars = [chr((raw >> 8 * i) & 0xFF) for i in range(4)]
    return "".join(c if c.isprintable() else "?" for c in chars)


@dataclass
class DeviceInfo:
    index: int
    opened: bool
    width: int = 0
    height: int = 0
    fourcc: str = ""
    driver_fps: float = 0.0
    os_name: str | None = None
    os_name_is_heuristic: bool = False
    signature: str | None = None
    modes: list[dict] = field(default_factory=list)
    # Linux by-path identity (None on Windows / index-scan fallback). The port
    # IS the identity on this hardware — the USB descriptor carries no unique
    # per-unit id, so cam_id is the ID_PATH port suffix, e.g. "usb-0:1.1".
    cam_id: str | None = None
    id_path: str | None = None
    control_profile: str | None = None
    usb: dict | None = None

    def describe(self) -> str:
        name = self.os_name or "(name unavailable)"
        if self.os_name_is_heuristic:
            name += "  [heuristic]"
        port = ""
        if self.cam_id:
            port = f"\n    port    : {self.cam_id}  profile={self.control_profile}"
        if not self.opened:
            return (
                f"index {self.index}: BUSY — node exists but another process holds it"
                f"{port}\n    os name : {name}"
            )
        sig = f"  -> {self.signature}" if self.signature else ""
        return (
            f"index {self.index}: {self.width}x{self.height} "
            f"fourcc={self.fourcc!r} driver_fps={self.driver_fps:.0f}\n"
            f"    os name : {name}{port}\n"
            f"    signature: max {self.width}x{self.height}{sig}"
        )


def _windows_pnp_cameras() -> list[dict]:
    """Camera names Windows knows about. Enumeration order is NOT the OpenCV
    index order, so these names can only be attached heuristically."""
    ps = shutil.which("powershell") or shutil.which("pwsh")
    if not ps:
        return []
    script = (
        "Get-CimInstance Win32_PnPEntity | "
        "Where-Object { $_.PNPClass -eq 'Camera' -or $_.Service -eq 'usbvideo' } | "
        "Select-Object Name, DeviceID | ConvertTo-Json -Compress"
    )
    try:
        out = subprocess.run(
            [ps, "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=30, check=False,
        ).stdout.strip()
        if not out:
            return []
        data = json.loads(out)
        return data if isinstance(data, list) else [data]
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return []


def _linux_v4l2_cameras() -> dict[int, str]:
    """Exact index -> name mapping from sysfs."""
    root = Path("/sys/class/video4linux")
    if not root.is_dir():
        return {}
    names: dict[int, str] = {}
    for node in sorted(root.glob("video*")):
        try:
            names[int(node.name.removeprefix("video"))] = (node / "name").read_text().strip()
        except (ValueError, OSError):
            continue
    return names


# ---- Linux by-path enumeration -------------------------------------------
# Why not index scanning: each UVC camera creates TWO /dev/video* nodes (the
# even one captures, the odd one is a metadata node that never opens), so a
# fixed max_index misses cameras once enough are plugged in, and a scan cannot
# list a camera another process is holding. /dev/v4l/by-id is deliberately NOT
# used: on this hardware every camera reports the same USB descriptor identity,
# the by-id names collide, and udev keeps a mixed subset of symlinks — see
# docs/design/lab-desk-spec.md §1.2. The USB port path (ID_PATH) is the only
# stable key, so the port is the camera's identity (§2.1-2.2).

# ID_PATH "platform-3610000.usb-usb-0:1.1:1.0" splits into the host's USB
# controller ("platform-3610000.usb", stored once as rig.host.usbRoot) and the
# port path minus the config.interface suffix ("usb-0:1.1"), which is camId.
_ID_PATH_RE = re.compile(r"^(?P<root>.+)-(?P<cam>usb-\d+:[\d.]+):\d+\.\d+$")
_BY_PATH_LINK_RE = re.compile(r"^(?P<idp>.+)-video-index\d+$")


def _usb_descriptor(node: Path) -> dict | None:
    """USB descriptor fields from sysfs, walking up from the video node to the
    first ancestor that has ``idVendor`` (the USB device directory).

    These fields describe the *kind* of device, never the individual unit:
    on this hardware serial is a firmware version string shared by every
    camera (spec §1.1). They go into ``rig.cameras[].expect`` for the
    changed-device check, nothing more.
    """
    try:
        resolved = node.resolve()
    except OSError:
        return None
    for parent in resolved.parents:
        if not (parent / "idVendor").is_file():
            continue

        def read(name: str) -> str | None:
            try:
                return (parent / name).read_text().strip()
            except OSError:
                return None

        return {
            "vid_pid": f"{read('idVendor')}:{read('idProduct')}",
            "manufacturer": read("manufacturer"),
            "product": read("product"),
            "bcd_device": read("bcdDevice"),
            "serial": read("serial"),
        }
    return None


def _linux_by_path_cameras() -> list[dict]:
    """One entry per physical camera, grouped by ID_PATH, nothing opened.

    Walks ``/sys/class/video4linux/*`` for the node list and each node's
    ``index`` attribute (0 = capture node, the rest are metadata), and takes
    ID_PATH from the udev-maintained ``/dev/v4l/by-path`` symlink names.
    Because no device is opened, cameras held by another process still appear
    in the list — the caller reports them as busy instead of absent.
    """
    sys_root = Path("/sys/class/video4linux")
    by_path = Path("/dev/v4l/by-path")
    if not (sys_root.is_dir() and by_path.is_dir()):
        return []

    # /dev/videoN name -> ID_PATH, from links like
    #   platform-3610000.usb-usb-0:1.1:1.0-video-index0 -> ../../video0
    id_paths: dict[str, str] = {}
    try:
        links = list(by_path.iterdir())
    except OSError:
        return []
    for link in links:
        m = _BY_PATH_LINK_RE.match(link.name)
        if not m:
            continue
        try:
            id_paths[link.resolve().name] = m.group("idp")
        except OSError:
            continue

    cameras: dict[str, dict] = {}
    for node in sorted(sys_root.glob("video*")):
        id_path = id_paths.get(node.name)
        if id_path is None:
            continue  # not reached over USB (e.g. a CSI camera) — out of scope
        try:
            node_index = int((node / "index").read_text().strip())
        except (OSError, ValueError):
            continue
        cam = cameras.setdefault(id_path, {
            "id_path": id_path, "capture": None, "name": None, "usb": None,
        })
        if node_index == 0 and cam["capture"] is None:
            cam["capture"] = int(node.name.removeprefix("video"))
            try:
                cam["name"] = (node / "name").read_text().strip()
            except OSError:
                pass
            cam["usb"] = _usb_descriptor(node)

    out = []
    for id_path, cam in cameras.items():
        if cam["capture"] is None:
            continue  # metadata nodes only — no way to capture from this
        m = _ID_PATH_RE.match(id_path)
        cam["cam_id"] = m.group("cam") if m else id_path
        cam["usb_root"] = m.group("root") if m else None
        out.append(cam)
    out.sort(key=lambda c: c["cam_id"])
    return out


# ---- control profiles ------------------------------------------------------
# V4L2 control ids from videodev2.h.
_V4L2_CID_HUE = 0x00980903
_V4L2_CID_BACKLIGHT_COMPENSATION = 0x0098091C
# struct v4l2_queryctrl: u32 id, u32 type, char name[32], s32 minimum/maximum/
# step/default_value, u32 flags, u32 reserved[2] — 68 bytes.
_QUERYCTRL_FMT = "II32siiiiIII"
# VIDIOC_QUERYCTRL = _IOWR('V', 36, struct v4l2_queryctrl)
#                  = (3 << 30) | (68 << 16) | (ord('V') << 8) | 36
_VIDIOC_QUERYCTRL = 0xC0445624
_V4L2_CTRL_FLAG_DISABLED = 0x0001


def _v4l2_ctrl_range(fd: int, cid: int) -> tuple[int, int] | None:
    import fcntl  # Linux-only module; this path never runs on Windows

    req = struct.pack(_QUERYCTRL_FMT, cid, 0, b"", 0, 0, 0, 0, 0, 0, 0)
    try:
        res = fcntl.ioctl(fd, _VIDIOC_QUERYCTRL, req)
    except OSError:
        return None
    vals = struct.unpack(_QUERYCTRL_FMT, res)
    if vals[8] & _V4L2_CTRL_FLAG_DISABLED:
        return None
    return (vals[3], vals[4])  # minimum, maximum


def control_profile(dev_node: str) -> str:
    """Weak identity from V4L2 control ranges (spec §2.4).

    Individual units cannot be told apart (§1.1), but *kinds* can: the
    trigger-capable module repurposes Backlight Compensation as its
    trigger-mode switch, so its range is exactly 0..3, with Hue 1..200
    carrying the trigger frequency. An ordinary webcam control map
    (Backlight 16..160) means no trigger firmware — wiring FSIN to it does
    nothing. Anything else reports ``unknown`` honestly instead of being
    passed off as a recognised device.

    Querying control ranges works on a device another process is streaming
    from — only streaming is exclusive, ioctl QUERYCTRL is not.
    """
    if not IS_LINUX:
        return "unknown"
    try:
        fd = os.open(dev_node, os.O_RDWR | os.O_NONBLOCK)
    except OSError:
        return "unknown"
    try:
        backlight = _v4l2_ctrl_range(fd, _V4L2_CID_BACKLIGHT_COMPENSATION)
        hue = _v4l2_ctrl_range(fd, _V4L2_CID_HUE)
    finally:
        os.close(fd)
    if backlight == (0, 3) and hue == (1, 200):
        return "trigger-v1"
    if backlight == (16, 160):
        return "webcam-std"
    return "unknown"


def probe_max_resolution(index: int, api: int | None = None) -> tuple[int, int] | None:
    """Largest honoured resolution, found by descending — a few opens, not a full sweep.

    This is what makes the capability signature usable by default. Without it
    the reported size is whatever mode the driver happened to start in (often
    640x480), which identifies nothing.
    """
    api = default_backend() if api is None else api
    for (w, h) in sorted(MODE_CANDIDATES, key=lambda m: -m[0] * m[1]):
        cap = cv2.VideoCapture(index, api)
        if not cap.isOpened():
            cap.release()
            return None
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))  # last, see above
        ok, frame = cap.read()
        actual = (frame.shape[1], frame.shape[0]) if (ok and frame is not None) else None
        cap.release()
        if actual == (w, h):
            return (w, h)
    return None


def probe_modes(index: int, api: int | None = None) -> list[dict]:
    """Which (resolution, fourcc) combos the device actually honours.

    A UVC device silently substitutes its nearest supported mode instead of
    failing, so a request is 'supported' only when the driver reports back the
    exact size AND a decoded frame comes out at that size. Reopening per combo
    is deliberate: settings applied to a live capture leak into the next probe.
    """
    api = default_backend() if api is None else api
    supported = []
    for fcc in FOURCC_CANDIDATES:
        for (w, h) in MODE_CANDIDATES:
            cap = cv2.VideoCapture(index, api)
            if not cap.isOpened():
                cap.release()
                continue
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
            cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*fcc))  # last, see above
            ok, frame = cap.read()
            got_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            got_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            got_fcc = fourcc_of(cap)
            fps = cap.get(cv2.CAP_PROP_FPS)
            actual = (frame.shape[1], frame.shape[0]) if (ok and frame is not None) else None
            cap.release()
            # The format must have survived too, or this row is a duplicate of
            # whatever the driver fell back to.
            if actual == (w, h) and (got_w, got_h) == (w, h) and got_fcc == fcc:
                supported.append({"width": w, "height": h, "fourcc": fcc, "driver_fps": fps})
    return supported


def list_devices(max_index: int = 5, api: int | None = None, with_modes: bool = False) -> list[DeviceInfo]:
    """All cameras the OS can see.

    On Linux this enumerates by USB port path (``max_index`` is ignored —
    by-path has no upper bound and never mistakes a metadata node for a
    camera); elsewhere, and on a Linux box without ``/dev/v4l/by-path``,
    the index scan remains as the fallback.
    """
    api = default_backend() if api is None else api
    if IS_LINUX:
        cams = _linux_by_path_cameras()
        if cams:
            return _list_devices_by_path(cams, api, with_modes)
    return _list_devices_index_scan(max_index, api, with_modes)


def _probe_open(info: DeviceInfo, api: int, with_modes: bool) -> None:
    """Fill width/height/fourcc/signature by actually opening the device.
    Leaves ``info.opened`` False when the open or first read fails."""
    cap = cv2.VideoCapture(info.index, api)
    if not cap.isOpened():
        cap.release()
        return
    ok, _ = cap.read()
    if ok:
        info.opened = True
        info.width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        info.height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        info.fourcc = fourcc_of(cap)
        info.driver_fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    if not info.opened:
        return
    if with_modes:
        info.modes = probe_modes(info.index, api)
        if info.modes:
            best = max(info.modes, key=lambda m: m["width"] * m["height"])
            info.width, info.height = best["width"], best["height"]
    else:
        # The startup mode is usually 640x480 and identifies nothing, so
        # find the real ceiling — that is the part of the signature that
        # separates an AR0234 from a webcam.
        best = probe_max_resolution(info.index, api)
        if best:
            info.width, info.height = best
    info.signature = SIGNATURES.get((info.width, info.height))


def _list_devices_by_path(cams: list[dict], api: int, with_modes: bool) -> list[DeviceInfo]:
    devices: list[DeviceInfo] = []
    for cam in cams:
        index = cam["capture"]
        info = DeviceInfo(
            index=index,
            opened=False,
            os_name=cam.get("name"),
            cam_id=cam["cam_id"],
            id_path=cam["id_path"],
            usb=cam.get("usb"),
            control_profile=control_profile(f"/dev/video{index}"),
        )
        _probe_open(info, api, with_modes)
        # A camera held by another process stays in the list with
        # opened=False — the server must say "busy", not pretend the port
        # is empty (spec §2.3).
        devices.append(info)
    return devices


def _list_devices_index_scan(max_index: int, api: int, with_modes: bool) -> list[DeviceInfo]:
    linux_names = _linux_v4l2_cameras() if IS_LINUX else {}
    win_names = _windows_pnp_cameras() if IS_WINDOWS else []

    devices: list[DeviceInfo] = []
    for index in range(max_index):
        info = DeviceInfo(index=index, opened=False)
        _probe_open(info, api, with_modes)
        if not info.opened:
            # In a scan, "did not open" and "does not exist" are the same
            # observation — only by-path enumeration can tell them apart.
            continue

        if index in linux_names:
            info.os_name = linux_names[index]
        elif win_names:
            # Attach by enumeration position only. Windows does not guarantee
            # this order matches DirectShow's, hence the heuristic flag.
            slot = len(devices)
            if slot < len(win_names):
                info.os_name = win_names[slot].get("Name")
                info.os_name_is_heuristic = True

        devices.append(info)
    return devices


def find_index(prefer: tuple[int, int] = (1920, 1200), max_index: int = 5,
               api: int | None = None) -> int | None:
    """Index of the first device supporting ``prefer``, or None.

    Lets scripts say "give me the AR0234" instead of hardcoding an index that
    changes across replugs and machines.
    """
    for index in range(max_index):
        cap = cv2.VideoCapture(index, api if api is not None else default_backend())
        if not cap.isOpened():
            cap.release()
            continue
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, prefer[0])
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, prefer[1])
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))  # last, see above
        ok, frame = cap.read()
        actual = (frame.shape[1], frame.shape[0]) if (ok and frame is not None) else None
        cap.release()
        if actual == prefer:
            return index
    return None


def build_gst_pipeline(index: int, width: int, height: int, fourcc: str = "MJPG",
                       fps: int | None = None, decode_path: str = "cpu") -> str:
    """v4l2src pipeline delivering BGR frames to OpenCV.

    ``decode_path="nvjpg"`` decodes MJPG on the Jetson's fixed-function JPEG
    engine (NVJPG) instead of the CPU. This is the deployment path that a
    plain ``cv2.VideoCapture(index)`` can never measure — the classic backend
    always decodes in software, on the Jetson too. The explicit
    ``video/x-raw`` after the decoder forces system-memory output (nvjpegdec
    can also emit NVMM buffers, which videoconvert cannot take), and
    ``appsink drop=true max-buffers=1`` mirrors the ``CAP_PROP_BUFFERSIZE=1``
    latency choice of the classic path.
    """
    rate = f",framerate={int(fps)}/1" if fps else ""
    if fourcc == "MJPG":
        decoder = "nvjpegdec" if decode_path == "nvjpg" else "jpegdec"
        source = (f"image/jpeg,width={width},height={height}{rate} "
                  f"! {decoder} ! video/x-raw")
    else:
        if decode_path == "nvjpg":
            raise RuntimeError(f"nvjpg decodes JPEG only — an uncompressed {fourcc} "
                               f"stream has nothing to decode")
        source = f"video/x-raw,format={fourcc},width={width},height={height}{rate}"
    return (f"v4l2src device=/dev/video{index} ! {source} ! videoconvert ! "
            f"video/x-raw,format=BGR ! appsink drop=true max-buffers=1 sync=false")


def _open_gstreamer(index: int, width: int, height: int, fourcc: str,
                    fps: int | None, decode_path: str) -> cv2.VideoCapture:
    if not IS_LINUX:
        raise RuntimeError(
            "the gstreamer/nvjpg capture path needs Linux (v4l2src); run the same "
            "command on the Jetson. CPU-path numbers from this machine do not "
            "transfer to it.")
    if not gstreamer_available():
        raise RuntimeError(
            "this OpenCV build has no GStreamer support (see cv2.getBuildInformation()).")
    pipeline = build_gst_pipeline(index, width, height, fourcc, fps, decode_path)
    # Printed so a console log is enough to reproduce the exact measurement.
    print(f"  gstreamer pipeline: {pipeline}", file=sys.stderr)
    cap = cv2.VideoCapture(pipeline, cv2.CAP_GSTREAMER)
    if not cap.isOpened():
        raise RuntimeError(
            f"cannot open pipeline: {pipeline}\n  unlike the classic backends, the "
            f"caps must match a supported mode exactly — check "
            f"`v4l2-ctl -d /dev/video{index} --list-formats-ext`.")
    return cap


def open_capture(index: int, width: int, height: int, fourcc: str = "MJPG",
                 fps: int | None = None, api: int | None = None,
                 buffersize: int = 1, decode_path: str | None = None) -> cv2.VideoCapture:
    """Open at an explicit mode and verify it took.

    ``buffersize=1`` matters for latency work: the default driver queue hands
    back stale frames, so measured lag would include queue depth rather than
    real capture delay.
    """
    if api is None:
        api = _CAPTURE_DEFAULTS["api"]
    if api is None:
        api = default_backend()
    if decode_path in (None, "auto"):
        decode_path = _CAPTURE_DEFAULTS["decode_path"]
    if decode_path == "nvjpg" and api != cv2.CAP_GSTREAMER:
        api = cv2.CAP_GSTREAMER  # nvjpegdec exists only inside a GStreamer pipeline
    if api == cv2.CAP_GSTREAMER:
        return _open_gstreamer(index, width, height, fourcc, fps, decode_path)
    cap = cv2.VideoCapture(index, api)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open camera index {index} via {backend_name(api)}")
    # Order is load-bearing: size and fps first, FOURCC last. See
    # FOURCC_MUST_BE_SET_LAST above — any set() after it reverts the format.
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    if fps is not None:
        cap.set(cv2.CAP_PROP_FPS, fps)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, buffersize)
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*fourcc))

    got = (int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
    if got != (width, height):
        print(f"  warn: requested {width}x{height}, driver substituted {got[0]}x{got[1]}",
              file=sys.stderr)
    got_fourcc = fourcc_of(cap)
    if got_fourcc != fourcc:
        # Silently ignoring this would attribute YUY2 results to MJPG and make
        # any format comparison meaningless.
        print(f"  warn: requested fourcc {fourcc}, device reports {got_fourcc!r}",
              file=sys.stderr)
    return cap


class FrameTimer:
    """Frame-interval statistics.

    Mean fps alone is misleading — it hides both jitter and dropped frames. A
    capture that mostly runs at 60fps but stalls periodically averages out to
    something that looks like a uniformly slower stream, which would send you
    chasing throughput when the real defect is gaps. Interval percentiles plus
    an explicit long-gap count separate those two failure modes.
    """

    def __init__(self, drop_factor: float = 1.5):
        self.drop_factor = drop_factor
        self.intervals: list[float] = []
        self._last: float | None = None
        self.started = perf_counter()

    def tick(self) -> float | None:
        now = perf_counter()
        gap = None if self._last is None else now - self._last
        if gap is not None:
            self.intervals.append(gap)
        self._last = now
        return gap

    @property
    def frames(self) -> int:
        return len(self.intervals) + (1 if self._last is not None else 0)

    def summary(self) -> dict:
        if not self.intervals:
            return {"frames": self.frames, "note": "not enough frames"}
        ms = sorted(g * 1000.0 for g in self.intervals)
        median = statistics.median(ms)
        # A gap materially longer than the median means the pipeline missed a
        # frame period; count them rather than letting them melt into the mean.
        dropped = sum(1 for g in ms if g > median * self.drop_factor)

        def pct(p: float) -> float:
            return ms[min(len(ms) - 1, int(len(ms) * p))]

        total = sum(self.intervals)
        return {
            "frames": self.frames,
            "elapsed_s": round(total, 3),
            "mean_fps": round(len(self.intervals) / total, 2) if total else 0.0,
            "interval_ms": {
                "p50": round(median, 2),
                "p95": round(pct(0.95), 2),
                "p99": round(pct(0.99), 2),
                "max": round(ms[-1], 2),
            },
            "jitter_ms_stdev": round(statistics.pstdev(ms), 2),
            "long_gaps": dropped,
            "long_gap_pct": round(100.0 * dropped / len(ms), 2),
        }


def print_summary(title: str, summary: dict) -> None:
    print(f"\n{title}")
    if "note" in summary:
        print(f"  {summary['note']} (frames={summary['frames']})")
        return
    iv = summary["interval_ms"]
    print(f"  frames {summary['frames']}  elapsed {summary['elapsed_s']}s  "
          f"mean {summary['mean_fps']} fps")
    print(f"  interval ms  p50 {iv['p50']}  p95 {iv['p95']}  p99 {iv['p99']}  max {iv['max']}"
          f"   jitter(sd) {summary['jitter_ms_stdev']}")
    print(f"  long gaps (>{1.5}x median): {summary['long_gaps']} "
          f"({summary['long_gap_pct']}%)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Identify UVC cameras visible to OpenCV")
    parser.add_argument("--max-index", type=int, default=5, help="highest index to probe")
    parser.add_argument("--modes", action="store_true",
                        help="probe every resolution x fourcc combo (slow: reopens per combo)")
    # Identification probes by index, which a GStreamer pipeline cannot do —
    # classic backends only here.
    parser.add_argument("--backend", choices=("auto", "dshow", "msmf", "v4l2"), default="auto")
    parser.add_argument("--json", type=Path, help="also write results as JSON")
    args = parser.parse_args()

    api = resolve_backend(args.backend)

    print(f"platform={platform.system()}  backend={backend_name(api)}  opencv={cv2.__version__}")
    if args.modes:
        print("probing modes — this reopens the device per combo and takes a while\n")

    devices = list_devices(args.max_index, api, with_modes=args.modes)
    if not devices:
        print("no cameras opened. check the cable, and that no other app holds the device.")
        return 1

    for dev in devices:
        print()
        print(dev.describe())
        if dev.modes:
            print("    supported modes:")
            for m in dev.modes:
                print(f"      {m['fourcc']}  {m['width']}x{m['height']}  "
                      f"driver_fps={m['driver_fps']:.0f}")

    if IS_WINDOWS:
        print("\nnote: Windows names are attached by enumeration order and may be wrong.")
        print("      the capability signature (max resolution / aspect) is the reliable id.")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        payload = [
            {k: v for k, v in vars(d).items()} for d in devices
        ]
        args.json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
