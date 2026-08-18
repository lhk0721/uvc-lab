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
- Discovery covers the four wiring cases the user actually uses: same WiFi/LAN,
  USB direct (`192.168.55.1`), LAN-port direct (link-local `169.254.x.x`), and
  a different network over Tailscale. mDNS cannot cross a tailnet, so Tailscale
  peers come from `tailscale status --json` when the CLI is present; the tailnet
  range is never scanned. Manual add by IP is a required escape hatch (corporate
  WiFi blocks multicast; guest networks isolate clients).
- Discovery is two-phase: collect `(address, route)` candidates in parallel, then
  identify over SSH/health and merge by the hostname the box reports. One Jetson
  can be reachable by several routes at once, so `Jetson.routes` is a list and
  `activeRoute` records the one in use. Preference: USB > LAN/mDNS > Tailscale.
- HTTP reaches the Jetson **through an SSH port forward**, not a directly exposed
  port. `serve_uvc_lab.py` keeps its default `127.0.0.1` bind; main forwards a
  local port to the Jetson's loopback with `ssh2` `forwardOut`, and the renderer
  always talks to `http://127.0.0.1:<local>`. This collapses all four routes into
  one code path, opens no port on shared hardware, and keeps the renderer URL
  stable across route changes.
- SSH auth: **password**, never leaving the main process, never placed on a
  remote command line (`sudo -S` on stdin). `safeStorage` is a cipher, not a
  store: the encrypted blob is written to `app.getPath('userData')/
  credentials.json` (`%APPDATA%\uvc-lab-desk\` on Windows), with the key held by
  DPAPI/Keychain and bound to the OS account. No plaintext fallback — if
  `isEncryptionAvailable()` is false (or the Linux backend is `basic_text`), the
  app asks every time instead. No database; a JSON file is enough.
- sudo password: the app has no terminal, so it must be collected in-app — but not
  by default. For the usual same-account setup the SSH password IS the sudo
  password, so the stored one is tried first via `sudo -k -S -p '' -v`; only when
  that fails is a separate `sudoPassword` collected and stored in the same file
  under the same encryption. One failed attempt stops (repeats hit sudo's warning
  and `auth.log`), and if sudo is unusable at all (`requiretty`, not in sudoers)
  the app surfaces the one-line manual command instead of hiding the failure.
- Provision by SSH push: `git archive` tar streamed over `ssh2`; idempotent
  9-step bootstrap (check → act → verify) with a `VERSION` marker under
  `~/.uvc-lab/`. Everything installs inside the user's home.
- Server lifecycle: **systemd user unit** (`~/.config/systemd/user/`), driven by
  `systemctl --user start/stop`. Not enabled — no boot autostart. Two traps the
  implementation must handle: `XDG_RUNTIME_DIR` is absent in non-interactive
  SSH, and `loginctl enable-linger` is needed once per box (the only `sudo` on
  the normal path).
- Target OS is Ubuntu on `aarch64` (JetPack/L4T). `apt` is never used, so the
  only `sudo` on the normal path is `loginctl enable-linger`. Four consequences
  are written into the design: aarch64 wheels exist for `opencv-python`/`numpy`
  so nothing builds from source; JetPack 5 (Ubuntu 20.04) ships python3.8 while
  `pyproject.toml` requires >=3.10, resolved by `uv python install` rather than
  apt (hence uv is installed before python in the step order); the venv's cv2
  shadows JetPack's CUDA-built OpenCV, which is fine for V4L2 UVC capture; and
  avahi may be absent on server images, which silently removes the mDNS route
  and is reported rather than fixed.
- `v4l-utils` is NOT installed: `v4l2-ctl` only appears in a hint string in
  `uvc_devices.py`, never executed.
- Coexistence with other users of the Jetson: the server port may be taken on the
  Jetson's loopback (port is a unit argument, stored as `serverPort`), and
  `/dev/video*` may be held by an outside process (open failure must be reported
  as "busy", not a generic error).
- Port numbers are fixed: the Jetson binds `127.0.0.1:18100`, walking up to 18109
  if `ss -ltn` shows it taken; the laptop-side tunnel entrance starts at 18101,
  one per device, falling back to an OS-assigned port. 10000-range is deliberate —
  Linux's default `ip_local_port_range` is 32768-60999, so a fixed port at 49152+
  (the IANA dynamic range) collides intermittently with outbound ephemeral ports.
  The live tunnel URL is shown on the device card so the browser fallback path
  stays findable when the port is not the predicted one.
- `serve_uvc_lab.py` gains `/api/health` (version + hostname) so discovery can
  tell provisioned boxes and version drift.
- Known constraint: `uv sync` assumes the Jetson can reach PyPI; the user
  confirmed the Jetson is online, so offline wheel push stays out of scope.

Next step: implement in the commit order at the end of the design doc
(health endpoint → bootstrap/unit → `desktop/` skeleton → discovery →
provisioning → tunnel → device UI → lab UI → e2e on real hardware, once per
route).

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

## docs: 탐색 경로 4종 + SSH 터널 경유 확정 (#2)

- What: reworked the discovery, transport, credential-storage, and provisioning
  sections of `docs/design/jetson-lab-desk.md`. Discovery grows from three steps
  to four real wiring cases (same LAN / USB direct / LAN-port direct / Tailscale)
  and becomes two-phase, with `Jetson.route` replaced by a `routes` list plus
  `activeRoute`. HTTP now rides an SSH port forward instead of a directly exposed
  port. Added where `safeStorage` output actually lands on disk, and an OS
  subsection covering the aarch64/Ubuntu assumptions. Renumbered sections 3-6 and
  extended the commit order to nine steps.
- Why: the user described how they actually connect to the Jetson, and one case
  was unreachable by the old design — on a different network via Tailscale, mDNS
  cannot cross the tailnet and scanning 100.64.0.0/10 is not viable, so peers
  have to come from `tailscale status --json`. That case also exposed two gaps:
  a single `route` field would show one box as several cards once more than one
  path is live, and each route would otherwise need its own HTTP address. Routing
  HTTP through the SSH tunnel collapses all four cases into one path, and — since
  the Jetson is shared hardware — avoids opening a port on it at all. The
  credential and OS questions were the user's; both are answered in the design
  rather than left to implementation time.
- How verified: documentation only, no code paths touched. Two claims were
  checked against the repo rather than assumed. `serve_uvc_lab.py:305` defaults
  `--host` to `127.0.0.1`, which is what makes "keep loopback, tunnel instead"
  the cheap option rather than a change of behaviour; the same argparse block
  already exposes `--port`, so the unit can pass both and no existing code needs
  editing. `/api/health` remains the single change to existing code. The Python
  version constraint comes from `pyproject.toml` (`requires-python = ">=3.10"`),
  which is what makes JetPack 5's python3.8 a real bootstrap step rather than a
  hypothetical one.

## docs: sudo 자격증명 처리 + 포트 번호 18100 확정 (#2)

- What: added a `### sudo 비밀번호` subsection to the auth section and a
  `### 포트 번호 — Jetson 18100` subsection to the coexistence section of
  `docs/design/jetson-lab-desk.md`, and replaced every remaining `8100` in the
  diagram, data model, and tunnel section with `18100`. The coexistence bullet
  that used to describe port conflict inline now points at the new subsection.
- Why: both were the user's calls. On sudo, the app has no terminal so the
  password must be collected in-app — but the design would have been wrong to
  add a second stored secret by default, because in the usual same-account setup
  the SSH password already IS the sudo password and is already stored. So the
  stored one is tried first and a separate `sudoPassword` exists only for the
  different-account case. On ports, "somewhere in the 10000s" is correct for a
  reason worth writing down: Linux's default `ip_local_port_range` is
  32768-60999, so a fixed port in the IANA dynamic range (49152+) collides
  intermittently with outbound ephemeral ports — a failure that reproduces
  badly. 18100 sits below that range and keeps the old 8100 as a mnemonic.
- How verified: documentation only, no code paths touched. `grep -n 8100` over
  the design doc confirms the four stale references were the diagram (line 38),
  the `serverPort` comment (136), the tunnel destination (285), and the
  exposure rationale (293), and that the remaining matches are the new
  subsection's deliberate references to the old number. The sudo invocation is
  written as `sudo -k -S -p '' -v` so that `-k` makes the check independent of a
  cached timestamp and `-p ''` removes the prompt string from stderr; the design
  records the one-attempt limit and the manual `loginctl enable-linger` escape
  hatch rather than assuming sudo always works.
