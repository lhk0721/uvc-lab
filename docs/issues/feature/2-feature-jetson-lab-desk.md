# 2 feature: Jetson 자동 배포 + Lab Desk 컨트롤 앱

## Summary
- Issue: #2
- Branch: `2-feature-jetson-lab-desk`
- Umbrella: #1
- Status: in progress

## Current State

Design revised with the user and rewritten in `docs/design/jetson-lab-desk.md`
(Korean, human-facing). Implementation has not started. Decisions locked in:

- Laptop-side app ("Lab Desk"): **Electron + React + TypeScript** under
  `desktop/`, built with electron-vite, packaged with electron-builder.
  Renderer is a pure SPA — no meta-framework, since the server role is already
  taken by the Jetson and by Electron main. TanStack Router / TanStack Query /
  Zustand. No CLI — buttons only.
- Process boundary: SSH, mDNS, and filesystem work live in Electron main.
  Renderer runs with `nodeIntegration: false`, `contextIsolation: true`.
- Multi-device from the start: all state is keyed by a Jetson id, even though
  the UI shows one device today.
- Discovery order: 192.168.55.1 (USB device mode) → mDNS → subnet SSH scan.
- SSH auth: **password**, stored via Electron `safeStorage`, never leaving the
  main process, never placed on a remote command line (`sudo -S` on stdin).
- Provision by SSH push: `git archive` tar streamed over `ssh2`; idempotent
  9-step bootstrap (check → act → verify) with a `VERSION` marker under
  `~/.uvc-lab/`. Everything installs inside the user's home.
- Server lifecycle: **systemd user unit** (`~/.config/systemd/user/`), driven by
  `systemctl --user start/stop`. Not enabled — no boot autostart. Two traps the
  implementation must handle: `XDG_RUNTIME_DIR` is absent in non-interactive
  SSH, and `loginctl enable-linger` is needed once per box (the only `sudo` on
  the normal path).
- `v4l-utils` is NOT installed: `v4l2-ctl` only appears in a hint string in
  `uvc_devices.py`, never executed. JetPack ships python3, so `apt` is expected
  to be skipped entirely.
- Coexistence with other users of the Jetson: port 8100 may be taken (port is a
  unit argument), and `/dev/video*` may be held by an outside process (open
  failure must be reported as "busy", not a generic error).
- `serve_uvc_lab.py` gains `/api/health` (version + hostname) so discovery can
  tell provisioned boxes and version drift.
- Known constraint: `uv sync` assumes the Jetson can reach PyPI; the user
  confirmed the Jetson is online, so offline wheel push stays out of scope.

Next step: implement in the commit order at the end of the design doc
(health endpoint → bootstrap/unit → `desktop/` skeleton → discovery →
provisioning → device UI → lab UI → e2e on real hardware).

## feature: Jetson Lab Desk 설계 문서 (#2)

- What: added `docs/design/jetson-lab-desk.md`, this management document, the
  umbrella document for #1, the two Master Registry rows, and the Recent Active
  Context pointer.
- Why: the deployment story had to be settled before writing code. The obvious
  reading of the request ("userdata script") does not apply to a Jetson — that
  path needs a re-flash — so the design records SSH push as the deliberate
  substitute, along with two decisions that came out of the discussion: the
  server must NOT autostart at boot (the Jetson is not a camera-only box), and
  the operator drives it from a windowed app, not a CLI.
- How verified: documentation only, no code paths touched. Checked that the
  design matches the repo as it stands — the existing FastAPI + single-HTML
  pattern of `serve_uvc_lab.py` / `uvc_lab.html` is what the control app reuses,
  and `/api/health` is confirmed absent today, so it is listed as the one change
  to existing code.

## docs: Lab Desk 설계 문서 개정 — Electron + React 스택 (#2)

- What: rewrote `docs/design/jetson-lab-desk.md` and refreshed the Current State
  block above. The laptop app moves from "FastAPI + one HTML page opened in
  Chrome `--app` mode" to a real Electron + React + TypeScript desktop app; SSH
  auth is fixed as password + `safeStorage`; the systemd unit moves from a
  system unit to a **user** unit; the data model becomes multi-device from the
  start. Also updated the body of issue #2 to match.
- Why: the earlier design predates the discussion that settled the app's shape.
  Three things drove the change. (1) The app has to discover boxes, hold SSH
  sessions, and push installs — that is Node work in a main process, not a local
  web server. (2) The Jetson is shared hardware, so provisioning must not touch
  the system: a user unit removes `sudo` from install/start/stop and keeps
  everything under `$HOME`. (3) Discovery inherently produces a list, so
  assuming a single Jetson would have to be undone later; keying state by
  Jetson id now costs nothing.
- How verified: documentation only, no code paths touched. Two claims in the
  design were checked against the repo rather than assumed — `v4l2-ctl` appears
  only inside a hint string in `uvc_devices.py:505` and is never executed (so
  `v4l-utils` is dropped from bootstrap), and `/api/health` is still absent from
  `serve_uvc_lab.py` (so it stays listed as the one change to existing code).
