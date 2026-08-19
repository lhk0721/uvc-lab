#!/usr/bin/env bash
# bootstrap.sh — idempotent install of the uvc-lab server on a Jetson.
#
# Runs ON the box, as the target user, never as root. Steps 1-2 of the design
# (TCP reachability, SSH auth) belong to the calling app; this script covers
# steps 3-9 of docs/design/jetson-lab-desk.md as check -> act -> verify, so
# re-running it is always safe. Everything lands inside $HOME — apt is never
# touched, and the only sudo on the normal path is enable-linger, once per box.
#
# The payload must already be extracted to ~/.uvc-lab/repo. Lab Desk streams
# `git archive` tar over SSH before invoking this; by hand from a checkout:
#
#   git archive HEAD | ssh <box> 'mkdir -p ~/.uvc-lab/repo && tar -x -C ~/.uvc-lab/repo'
#   ssh <box> 'bash ~/.uvc-lab/repo/deploy/bootstrap.sh --version <ver> --port 18100'
#
# Exit codes:
#   0  installed and ready
#   3  installed, but lingering is off — the printed sudo command is the one
#      remaining step (the app runs it via `sudo -S` with the stored password)
#   1  a step failed; the FAIL line says which

set -uo pipefail

VERSION=""
PORT=18100
while [ $# -gt 0 ]; do
    case "$1" in
        --version) VERSION="$2"; shift 2 ;;
        --port)    PORT="$2";    shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done

BASE="$HOME/.uvc-lab"
REPO="$BASE/repo"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/uvc-lab.service"
ME="$(id -un)"

# User-unit trap #1 (design §5): non-interactive SSH has no XDG_RUNTIME_DIR,
# and without it `systemctl --user` cannot find the user D-Bus.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
# uv installs into ~/.local/bin, which non-interactive shells don't have.
export PATH="$HOME/.local/bin:$PATH"

fail() { echo "FAIL: $*" >&2; exit 1; }

# ---- 3/9 environment -------------------------------------------------------
printf '[3/9] environment  '
ARCH="$(uname -m)"
[ "$ARCH" = "aarch64" ] || fail "expected aarch64, got $ARCH — this is not a Jetson"
command -v systemctl >/dev/null 2>&1 || fail "systemd is not present"
systemctl --user show-environment >/dev/null 2>&1 \
    || fail "user systemd manager unreachable (XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR)"
OS_NAME="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")"
# avahi may be missing on server images; that only removes the mDNS discovery
# route, so it is reported, never installed (would need sudo; other routes exist).
if systemctl is-active --quiet avahi-daemon 2>/dev/null; then MDNS="available"; else MDNS="UNAVAILABLE"; fi
echo "ok  ($ARCH, $OS_NAME, mDNS $MDNS)"

# ---- 4/9 uv ----------------------------------------------------------------
printf '[4/9] uv           '
if command -v uv >/dev/null 2>&1; then
    echo "ok  ($(uv --version 2>/dev/null | head -1), already installed)"
else
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 \
        || fail "uv install script failed (is the box online?)"
    command -v uv >/dev/null 2>&1 || fail "uv still not on PATH after install"
    echo "ok  ($(uv --version 2>/dev/null | head -1), installed to ~/.local/bin)"
fi

# ---- 5/9 python ------------------------------------------------------------
printf '[5/9] python       '
if python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
    echo "ok  (system $(python3 --version 2>&1 | cut -d' ' -f2))"
else
    # JetPack 5 ships python3.8; never apt-upgrade a shared box — let uv fetch
    # a standalone python into $HOME instead (design §4, OS section).
    uv python install >/dev/null 2>&1 || fail "uv python install failed"
    echo "ok  (uv-managed python installed; system python3 is too old)"
fi

# ---- 6/9 payload -----------------------------------------------------------
printf '[6/9] payload      '
[ -f "$REPO/serve_uvc_lab.py" ] && [ -f "$REPO/pyproject.toml" ] \
    || fail "payload missing — extract the repo to $REPO first (see script header)"
mkdir -p "$BASE"
# The push-or-skip decision against this marker is the app's, made BEFORE the
# tar push; here it is only recorded so /api/health can report the version.
if [ -n "$VERSION" ]; then
    printf '%s\n' "$VERSION" > "$BASE/VERSION"
    echo "ok  (version $VERSION)"
else
    echo "ok  (version marker left as-is)"
fi

# ---- 7/9 dependencies ------------------------------------------------------
printf '[7/9] dependencies '
# uv sync is its own check: when the venv already satisfies pyproject it is a
# fast no-op. uv.lock is gitignored, so resolution happens on the box.
SYNC_OUT="$(cd "$REPO" && uv sync 2>&1)" || fail "uv sync failed: $SYNC_OUT"
"$REPO/.venv/bin/python" -c 'import cv2, fastapi, uvicorn' 2>/dev/null \
    || fail "venv import check failed (cv2/fastapi/uvicorn)"
echo "ok  (.venv imports cv2, fastapi, uvicorn)"

# ---- 8/9 unit --------------------------------------------------------------
printf '[8/9] unit         '
TEMPLATE="$REPO/deploy/uvc-lab.service"
[ -f "$TEMPLATE" ] || fail "unit template missing: $TEMPLATE"
RENDERED="$(sed "s/@PORT@/$PORT/g" "$TEMPLATE")"
if [ -f "$UNIT" ] && [ "$RENDERED" = "$(cat "$UNIT")" ]; then
    echo "ok  (already installed, port $PORT)"
else
    mkdir -p "$UNIT_DIR"
    printf '%s\n' "$RENDERED" > "$UNIT"
    systemctl --user daemon-reload || fail "daemon-reload failed"
    systemctl --user cat uvc-lab >/dev/null 2>&1 || fail "unit did not load after install"
    echo "ok  (installed, port $PORT)"
fi
# Not a failure: the holder may be our own already-running unit, and the app
# re-checks with `ss -ltn` before every start anyway (design §6).
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q "127\.0\.0\.1:$PORT "; then
    echo "      note: 127.0.0.1:$PORT is currently in use"
fi

# ---- 9/9 linger ------------------------------------------------------------
printf '[9/9] linger       '
if [ "$(loginctl show-user "$ME" --property=Linger --value 2>/dev/null)" = "yes" ]; then
    echo "ok  (already enabled)"
else
    # Without linger the user manager — and the server with it — dies when the
    # SSH session ends. Needs sudo once per box; this script never handles
    # passwords, so try passwordless sudo and otherwise hand the command back.
    if sudo -n loginctl enable-linger "$ME" 2>/dev/null; then
        echo "ok  (enabled)"
    else
        echo "NEEDS SUDO"
        echo "      run once:  sudo loginctl enable-linger $ME"
        exit 3
    fi
fi

echo "bootstrap complete — start with: systemctl --user start uvc-lab"
