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

Behaviour spec written in `docs/design/lab-desk-spec.md` (Korean, human-facing),
grounded in a live inspection of the real Jetson on 2026-08-18 over the
link-local direct-LAN route (`169.254.203.230`; the Tailscale peer was offline).
What that inspection settled:

- The cameras have NO unique per-unit id. All three report VID:PID `1bcf:2d50`,
  `serial` `01.00.000` (a firmware version string, not a serial) and `bcdDevice`
  `0234`. A MAC-equivalent identity does not exist, so per-camera aliases cannot
  be derived from the device.
- `/dev/v4l/by-id/` is actively wrong here: identical names collide, udev keeps 4
  symlinks for 6 nodes, and the surviving pair mixes nodes from two different
  cameras. It is banned in the spec — it is worse than having nothing because the
  name looks authoritative.
- The only stable key is the USB port path (`ID_PATH`), so **the port is the
  identity**. `camId` is the port suffix (`usb-0:1.1`) with no hash wrapper, since
  a hash would only make the value unreadable on stickers and in error messages.
  Physical marking (`P1`/`P2`/`P4`) covers the one case software cannot: two
  identical cameras swapped between ports is undetectable, forever.
- Node count is twice the camera count (even = capture, odd = metadata, which
  fails to open). `list_devices(max_index=5)` finding 3 cameras is luck; a 4th
  camera would be missed. Enumeration moves to by-path.
- **The three cameras are not the same product.** V4L2 control ranges show ports
  1-2 with Backlight Compensation `0..3` + Hue `1..200` (the trigger-mode switch
  documented in rack-tracker's FSIN wiring doc), while port 4 has `16..160` /
  `-128..128` — an ordinary webcam control map. Port 4 has no trigger firmware, so
  3-camera hardware-trigger sync is impossible with this set. This is exactly the
  class of error the rig check exists to catch, and it would have looked like a
  wiring fault at test time.
- Target box is JetPack 6 (Ubuntu 22.04.5, L4T R36.5.0, python3 3.10.12, system
  cv2 4.8.0, no `uv`, no `v4l2-ctl`), so the python3.8 branch of the bootstrap
  does not apply here and trigger-mode switching must go through OpenCV
  (`CAP_PROP_BACKLIGHT`), not `v4l2-ctl`.

Design decisions that follow: `rig.json` lives on the Jetson (`~/.uvc-lab/`)
because the wiring is a property of the box, not of any laptop; registration is
snapshot-plus-label rather than a form; a 7-state match result gates entry to the
lab screen with an explicit "proceed anyway" that records `rigStatus` alongside
results; the wiring diagram renders observation as solid lines and declarations
(FSIN) as dashed; and test profiles carry a `requires` block so an impossible
combination is refused before it runs rather than producing numbers.

Wiring diagram scoped down with the user: nodes are the Jetson and the cameras
only (the hub is a label on the trunk, not a node, but the port number stays on
each camera node because the port IS the identity). No drag & drop. The Jetson is
placed by default and cannot be removed; its only editable fields are the two
GPIO pin assignments (BOARD 7 trigger out, BOARD 11 strobe in — defaults from
rack-tracker's FSIN wiring doc). Cameras are added from detection, or added
manually as **unbound** entries (no `camId` yet) when planning wiring before the
hardware is plugged in. Per-camera signal checkboxes come from a connector
profile; for this hardware that profile is `jst-3p-strb-trg-gnd`, confirmed
against the board silkscreen (`STRB`/`TRG`/`GND`) and the vendor manual's pin
definition. `GND` is not user-toggleable (it follows the others), `TRG` is
disabled on `webcam-std` cameras since wiring it cannot make the mode work, and
the first `TRG`/`STRB` check raises the 1.8V domain warning once — 3.3V destroys
the pin and the app cannot see whether a level shifter is present. The rig schema
therefore replaces the single `trigger.declared`/`targets` pair with per-camera
`connector` + `wiring` maps and a host-level `trigger` block holding the pins;
the trigger target list is derived from `wiring.TRG`, never stored twice.

Implementation has started. Spec steps 1-3 (the Jetson-server side, no Electron)
are coded: `/api/health`, by-path enumeration + control-profile detection in
`uvc_devices.py`, and `/api/rig` read/write. Health and rig endpoints and the
Windows index-scan fallback are verified locally. **Pending: step 2's success
criterion — exactly 3 cameras on `usb-0:1.1/1.2/1.4` with profiles
`trigger-v1`/`trigger-v1`/`webcam-std` — requires the live Jetson, which was
unreachable on every route (link-local, USB, Tailscale) on 2026-08-19. Run that
check the next time the box is up, before building anything on top of step 2.**

Step 4 is also coded: `deploy/bootstrap.sh` (steps 3-9 of the design as
check -> act -> verify; exit 3 = only linger's one sudo remains) and
`deploy/uvc-lab.service` (user unit template, `@PORT@` substituted at install,
no `[Install]` section so it can never be enabled). `.gitattributes` pins both
to LF so the CRLF working copy on Windows can never reach the box. Verified in
WSL Ubuntu under a throwaway `$HOME` with `uname`/`systemctl`/`loginctl`/`sudo`
shimmed: full run, idempotent re-run, port-change reinstall, and an ExecStart
smoke test (`.venv/bin/python serve_uvc_lab.py` answered `/api/health` with the
VERSION marker bootstrap wrote). Untestable off-Jetson and still pending there:
the aarch64 path, real `systemctl --user`/linger behavior, and the uv install
branch (the WSL harness pre-installed x86 uv).

Step 5 is coded: `desktop/` skeleton (electron-vite 5 + React 19 + TS) with the
main/preload/renderer boundary locked down (`contextIsolation: true`,
`nodeIntegration: false`, `sandbox: true`), a single `app:info` IPC roundtrip
proving the bridge, and the decided renderer stack in place (TanStack Router
code-based with hash history, TanStack Query, zustand installed for later).
vite is pinned to ^7 because electron-vite 5.0.0's peer range stops there.
`desktop` is `export-ignore`d so the Jetson payload tar never carries the app.
electron-builder packaging is not part of this step. Verified offline: typecheck
+ build clean, dev run showed the window and completed the IPC roundtrip.

Step 6 is coded: `src/main/discovery.ts`, phase 1 of the design's two-phase
discovery — candidates collected over the four wiring routes (USB `192.168.55.1`
TCP-22 probe, persistent `bonjour-service` `_ssh._tcp` browser, `tailscale
status --json` query filtered to online Linux peers with `relayed` derived from
`CurAddr`, and a subnet-scan fallback over the laptop's /24s plus the
link-local /16 that runs only when everything else came up empty) plus the
manual escape hatch, merged into `DiscoveredJetson` entries and pushed to the
renderer over `discovery:changed` (`list`/`scan`/`addManual`/`removeManual`
invoke channels alongside). Phase 2 identification is an injectable `identify`
hook that ssh.ts supplies in step 7; until then entries are provisional, keyed
by address — mDNS/tailscale names are display-only because the design forbids
trusting them as identity. The module never imports electron, so its logic runs
under plain Node for verification. Two real-world cases are handled explicitly:
a logged-out tailscale CLI reports `BackendState: "NoState"` with `Peer: null`
(observed on this laptop), and probe sockets use `on('error')` so a late RST
during scans cannot crash the main process. Route expiry is cycle-stamped
(usb/tailscale/lan-scan drop when their source stops reporting; a card with
other live routes survives), mdns follows goodbye packets, manual never expires.

Step 7 is coded: `src/main/credentials.ts` / `ssh.ts` / `provision.ts`.
Credentials follow the design's no-plaintext rule structurally — safeStorage is
injected as a cipher, the store owns `userData/credentials.json` (atomic write,
memory-only when encryption is unavailable), and the IPC surface is inward-only
(`canPersist`/`has`/`set`/`delete`; no channel returns a password). `ssh.ts`
wraps ssh2 (password + keyboard-interactive fallback, line-streamed exec, stdin
piping), keeps one pooled session per Jetson id, and supplies discovery's
phase-2 `identify` hook: stored credentials are tried against a candidate and
the box's own `hostname` becomes the id; failures are negative-cached keyed to
the credential set, so a foreign box's sshd is not retried every 10s cycle but
new credentials retry immediately. `provision.ts` runs the design's 9 steps:
tcp probe → auth (`needs-auth` on bad/missing credentials, distinct from
`failed`) → app-side VERSION-vs-app-version push decision with `git archive`
tar streamed into remote `tar -x` → server port picked before bootstrap renders
the unit (active unit keeps its port, else walk 18100-18109 past `ss -ltn`
listeners) → `bootstrap.sh` streamed line-by-line (`[N/9]` markers surface as
progress, `FAIL:` becomes the error) → on exit 3, linger via `sudo -k -S -p ''
-v` validation with the SSH password first (stored `sudoPassword` as the one
fallback, each tried exactly once) then `sudo -n loginctl enable-linger`;
unusable sudo yields `needs-sudo` plus the one-line manual command.
`startServer`/`stopServer` wrap `systemctl --user` (with the XDG_RUNTIME_DIR
export) and verify via `curl /api/health` on the box's own loopback, so the
tunnel is not needed for verification. State pushes over `provision:changed`,
log lines over `log:line`. Main-side relative imports now carry `.ts`
extensions (`allowImportingTsExtensions`) so the electron-free modules load
under plain Node; tests run with `node --experimental-transform-types`.

Step 8 is coded: `src/main/tunnel.ts` plus an `SshSession.forward` wrapper
around ssh2 `forwardOut`. Each Jetson gets one local TCP entrance bound to
laptop loopback — predictable ports first (18101-18109, walking past
EADDRINUSE/EACCES), then an OS-assigned port, so the browser fallback URL
stays guessable and the renderer receives the real value over IPC either way.
Every incoming connection is piped through the pooled SSH session into the
box's own loopback at the provisioned `serverPort`; the session is looked up
per connection via `SshPool.acquire`, so a dropped SSH session reconnects
from stored credentials on the next request instead of leaving a dead tunnel,
and no-session-no-credentials just drops that connection. Reopening the same
target is a no-op, a changed host/port replaces the tunnel, and open/close
push the full snapshot over `tunnel:changed` (`tunnel:open/close/list` invoke
channels alongside).

Step 9 is coded: the renderer grows real device cards and the log panel
(`store.ts`, `bridge.ts`, `DeviceCard.tsx`, `LogPanel.tsx`). A zustand vanilla
store mirrors the main-pushed state (discovery list, provision state keyed by
host, tunnel snapshots, log lines capped at 500) plus the card state that must
outlive a mount (server phase per Jetson id, chosen route per id); bridge.ts
wires the IPC subscriptions exactly once at module level, outside the React
lifecycle, so StrictMode double-mounting cannot double-subscribe. The card
shows the server-state dot, the version from `/api/health` after a start, all
live routes with the one in use switchable by click, the provision phase/step
line, and the live tunnel URL with a copy button; its actions are
install/reinstall (reinstall passes `forcePush`), start (`systemctl start` +
health check + tunnel open) and stop (tunnel close + `systemctl stop`).
`needs-auth` renders an inline credential form (save gated on `canPersist`);
`needs-sudo` renders the sudo-password form plus the manual command. Two small
main-side additions support that: `ProvisionRunOptions.auth` gained
`sudoPassword` (joins the linger candidates and is saved alongside when
`save`), and `credentials:setSudo` merges a sudo password into an existing
entry so the renderer never re-sends — or holds — the stored SSH password.
Anything keyed by Jetson id prefers the id provision reported
(`provision.jetsonId`), so a card acts correctly before discovery
re-identifies it.

Step 10 is coded: the rig registration screen and the wiring diagram
(`rig.ts`, `RigScreen.tsx`), the main-side relay they need
(`jetson-http.ts` plus the `devices:list` / `rig:get` / `rig:save` channels),
and three matching changes on the Jetson server. `jetson-http.ts` runs `curl`
against the box's own loopback over the pooled SSH session, so device and rig
requests need no open tunnel and no port on the Jetson's network; `rig:get`
maps 404 to null because "no rig yet" is a state, not a failure. `rig.ts`
holds the logic and no React: the section 5 match (all seven states, with
hub-moved proposed only when every bound port shifts by the same prefix and
the per-port control profiles still agree), the section 6.4 wiring rules (GND
follows the other signals and is never hand-toggled; TRG needs both a trigger
source pin and a control profile that is not known to lack the firmware), and
the diagram's port arithmetic (gaps between numeric ports are drawn as empty
slots). `RigScreen.tsx` renders that as the design's fixed layout - no drag &
drop: the Jetson node with its two editable GPIO pins, one row per port with
label, detected descriptor, control profile, signal checkboxes and the
declared-but-unverified dashed line, unbound cameras planned ahead (auto-bound
only when exactly one camera and exactly one free port make it unambiguous),
the 1.8V warning raised once on the first TRG/STRB check, and MJPEG previews
of every open camera through the tunnel so the registration screen itself is
the first place a mismatched camera shows up. Saving writes the whole rig to
the box. Server side: `DeviceBroker` was rewritten from one-consumer-at-a-time
to readers/writer - any number of previews run concurrently (the registration
screen needs all cameras at once) and are still preempted by one exclusive
user, which enters once the last preview has bowed out; `stream_stats` is
per index with the old flat shape kept for the single-preview page; and
`/api/devices` now also returns `idPath` so the client can derive
`rig.host.usbRoot`.

Step 11 is coded: the lab screen (`lab.ts`, `LabScreen.tsx`) with the server
work it needs. `lab.ts` is React-free and holds the parts worth testing without
a browser: the preview URL (a nonce is what makes a mode change take - an
`<img>` on an open multipart response never re-requests), the
requested-versus-observed comparison, control clamping against the range the
device reported, preset parameter coercion, run-log bookkeeping, and the
section 5 gate. `LabScreen.tsx` renders them: every camera previewing at once
through the tunnel, a mode form per camera whose result line shows what the
driver actually gave (with the substitution spelled out when it differs), a
parameter panel built from the device's own min/max/step/default, the existing
`uvc_lab_presets.py` presets with their parameter forms, and the run's output
flowing into the same log panel as provision and start. The section 5 gate
lives here: anything but `ok` blocks the screen and the way past it is an
explicit "무시하고 진행" that records the status on every run started
afterwards. Previews are dropped while a run holds the cameras and reconnect
when it finishes, because the broker preempts them and an `<img>` will not
retry on its own. Server side: `uvc_devices.py` gained a general V4L2 control
layer (`query_controls` / `set_control` over QUERYCTRL, QUERYMENU, G_CTRL and
S_CTRL on a separate fd, so it works while another consumer streams) and
`serve_uvc_lab.py` gained `/api/modes`, `GET`/`POST /api/controls`,
`/api/streams`, an `fps` parameter plus the requested/observed pair on the
stream stats, and a `rigStatus` field recorded on every run. Main relays all of
it (`lab:*` channels through `jetson-http.ts`, which now speaks POST and
refuses any path that could break out of the remote command line).

Section 7.4 (trigger verification) is deliberately NOT part of step 11 - the
step's own scope line lists preview, mode, parameters and benchmark. It needs
pulse generation from the Jetson's GPIO, which is a Jetson-side subsystem that
does not exist yet, and section 12 still records that the wiring itself is
unconfirmed on this box. It therefore needs its own step, after the wiring is
seen to exist.

Step 12 is coded: test profiles and the `requires` gate (spec section 8).
`profiles.ts` is React-free and holds the gate itself - `planProfile` turns a
profile plus the live devices and rig into the reasons it cannot run, the
things it will not honour, and the preset parameters it becomes.
`ProfilePanel.tsx` renders it inside the lab screen: a profile list, an editor
seeded from the ports that are plugged in right now, a per-camera row (enabled,
mode, free-running or hardware trigger), the preset parameters the camera block
does not derive, and the gate underneath - evaluated on every render, which is
what makes the check happen while the profile is being *looked at* rather than
when the run button is pressed. The spec's own example is refused here, with
its own message: port 4 carries `webcam-std`, so it cannot be a trigger target.
A profile lives on the Jetson (`~/.uvc-lab/profiles.json`, new `GET`/`PUT
/api/profiles`) for the same reason the rig does - it names port paths, which
only mean something on that box - and a run started from one records both the
profile id and the section 5 `rigStatus`.

Two decisions inside that gate are worth keeping written down. A camera set to
`trigger: "hardware"` is refused even when its firmware and wiring are in
order, because nothing in this app can drive the FSIN line yet (section 7.4);
running it anyway would measure a free-running camera and file the numbers
under a trigger profile. And a run is blocked while the editor has unsaved
changes: the result records the profile id, so the stored profile and the one
that produced the numbers must be the same thing.

Next step (step 13): with the Jetson on — verify step 2 (3 cameras on
`usb-0:1.1/1.2/1.4`, profiles `trigger-v1`×2 + `webcam-std`), see the box
discovered per route, run a real provision end-to-end from the card (aarch64
path, real linger/sudo, uv install branch), see real HTTP flow through the
tunnel to `serve_uvc_lab.py`, register the real rig from the screen (three
simultaneous previews, port identity, the section 5 match against the saved
rig), drive the lab screen against real cameras (the V4L2 control ioctls, which
no off-Jetson test can exercise; a real mode substitution; a preset run
preempting live previews), and run a test profile against the real set — where
the section 8 gate should refuse the trigger example on port 4 by itself. Every
offline step is now done; section 7.4's trigger verification still waits for a
step of its own, and it needs the wiring to be confirmed first (section 12).

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

## docs: Lab Desk 동작 명세 — 포트 기반 장치 식별과 rig 대조 (#2)

- What: added `docs/design/lab-desk-spec.md`, the behaviour spec covering device
  identity, the `rig` model, the match rules, the wiring diagram, the lab screen's
  actions, test profiles, and the IPC surface. Updated the Current State block
  above. Also corrected `docs/design/jetson-lab-desk.md` in two places: it claimed
  `/api/health` was the only change to existing code (now three — `/api/devices`
  enumeration is replaced and `/api/rig` is new), and the OS section now records
  which JetPack the measured box actually runs so the reader knows which branch of
  the python-version paragraph applies.
- Why: the user asked whether the hardware setup has to be declared to the app
  before it can call a mis-detection an error. It does — two cameras showing up is
  a fact, not a fault, until something says three were expected. The user then
  asked whether a MAC-like id could anchor per-camera aliases. It cannot, and that
  had to be established against the real hardware rather than assumed: all three
  cameras report the same VID:PID, the same `serial` (`01.00.000`, a firmware
  version string), and the same `bcdDevice`, which is also why `/dev/v4l/by-id/`
  collides and hands out a symlink pair that mixes two different cameras. The USB
  port path is the only stable key, so the spec makes the port the identity and
  assigns physical marking to the one failure mode software cannot see (two
  identical cameras swapped between ports).
- How verified: inspected the live Jetson over SSH on the link-local direct-LAN
  route (`169.254.203.230` — the Tailscale peer was offline, which incidentally
  exercised one of the four discovery routes). Read `ID_SERIAL`/`ID_PATH` via
  `udevadm info` and the `serial`/`manufacturer`/`bcdDevice` sysfs attributes for
  all three USB devices; confirmed the by-id collision by counting 4 symlinks
  against 6 nodes and following both to their targets; confirmed only the even
  video nodes open by running a `cv2.VideoCapture` probe over all six; and queried
  `VIDIOC_QUERYCTRL` directly for Backlight Compensation, Hue, and the exposure
  controls on each camera. That last check produced the finding that drives the
  spec's `requires` gate: ports 1-2 expose Backlight `0..3` (the trigger-mode
  switch) while port 4 exposes `16..160`, so port 4 has no trigger firmware and a
  3-camera hardware-trigger profile must be refused before it runs. No code was
  changed on the Jetson and no camera setting was left modified — the probes read
  control ranges and restored nothing because nothing was written.

## docs: 배선 다이어그램 명세 — 노드 축소와 신호 체크박스 (#2)

- What: rewrote section 6 of `docs/design/lab-desk-spec.md` into six subsections
  (what is drawn, the Jetson node, camera add/remove, signal checkboxes, the
  voltage warning, rendering rules) and changed the rig schema in section 3.2 to
  match: each camera gains `connector` and a `wiring` map, and the host-level
  `trigger` block now holds the GPIO pin assignments instead of a `declared` flag
  and a `targets` list. Section 7.4's entry condition and section 12's open items
  were updated to follow.
- Why: the user scoped the diagram down. Only the Jetson and the cameras are
  nodes, there is no drag & drop, the Jetson is placed by default since it is the
  only host, and the interaction is add camera / remove selected plus checkboxes
  for which connector signals are wired — actual wiring stays the user's job. Two
  things had to be decided rather than transcribed. The hub cannot be a node under
  that scope, but the port number is the camera's identity (section 2.1), so the
  hub became a label on the trunk while the port stayed on each camera node.
  And "add camera" conflicts with the rule that the diagram renders detection, so
  a manually added camera is an explicit unbound entry with no `camId` until a
  device appears on a port — binding asks the user whenever more than one port
  could match, because section 1.1 leaves the app no basis to decide.
- How verified: the signal list was not invented. rack-tracker
  `docs/etc/camera-sync/fsin-trigger-wiring.md` records the 3-pin JST silkscreen
  order as `STRB` / `TRG` / `GND` with `TRG` being the same pin the sensor
  datasheet calls FSIN, and the vendor manual's section 9 pin definition
  (3=Trigger, 4=Strobe/Flash, 5=GND) agrees; the same document is the source for
  the 1.8V domain, for the BOARD 7 / BOARD 11 pin defaults, and for the measured
  strobe level (1.627V) that justifies leaving `STRB` selectable regardless of
  control profile. The `TRG`-disabled-on-`webcam-std` rule follows from the
  control-range measurement already recorded in section 1.5. No new hardware
  access was needed for this change.

## feat: 서버 선행 3단계 — /api/health · by-path 열거 · /api/rig (#2)

- What: implemented spec §11 steps 1-3, the parts that need no Electron.
  `serve_uvc_lab.py` gains `GET /api/health` (app name, version from the
  `~/.uvc-lab/VERSION` marker the future bootstrap will write — "dev" without
  it — and hostname) and `GET/PUT /api/rig` against `~/.uvc-lab/rig.json`
  (404 when absent so the client's `no-rig` state is distinguishable, shallow
  validation of `rigVersion`/`cameras`, atomic tmp+replace write, state dir
  overridable via `UVC_LAB_HOME` for tests). `uvc_devices.py` replaces the
  index scan on Linux with by-path enumeration per §2.2 — nodes grouped by
  ID_PATH from `/dev/v4l/by-path` symlink names, capture node = sysfs
  `index==0`, `camId` = port suffix via regex, USB descriptor read from sysfs
  ancestors — plus control-profile detection per §2.4 (`trigger-v1` /
  `webcam-std` / `unknown`) via a raw `VIDIOC_QUERYCTRL` ioctl on Backlight
  Compensation and Hue (`v4l2-ctl` does not exist on the box). Busy cameras
  now stay in the list with `opened=false` instead of vanishing, `/api/devices`
  returns `camId`/`controlProfile`/`usb`/`opened`, and `uvc_lab.html` labels
  unopened devices "사용 중". The index scan remains as the fallback for
  Windows and for Linux boxes without `/dev/v4l/by-path`; the shared open-probe
  logic was factored into `_probe_open` so both paths stay identical.
- Why: §1.4 showed the index scan finds 3 cameras only by luck (nodes are 2×
  cameras; a 4th camera would be missed at `max_index=5`), and §1.5 showed the
  control ranges are the only way to see that the port-4 camera has no trigger
  firmware. These two steps are ordered first precisely because they catch that
  class of problem before any app exists. `/api/rig` comes now because the rig
  belongs on the box (§3.1) and the endpoint is independently verifiable.
- How verified: locally on Windows via `uv run`. `/api/health` returns
  version+hostname; `/api/rig` returns 404 before PUT, rejects a body missing
  `rigVersion` or `cameras` with 422, round-trips a Korean-labeled rig
  byte-identically, and writes pretty-printed UTF-8 JSON to the `UVC_LAB_HOME`
  dir (first PUT attempt failed only because git-bash curl sent cp949 — resent
  as a UTF-8 file body). Struct size (68) for `v4l2_queryctrl` and both
  ID_PATH regexes asserted against the measured Jetson strings. The index-scan
  fallback still finds the laptop webcam with heuristic naming intact.
  **NOT yet verified: the by-path path on the real Jetson (3 cameras on
  `usb-0:1.1/1.2/1.4`, profiles `trigger-v1`×2 + `webcam-std`) — the box was
  unreachable on all routes today. That check gates step 2's done-ness.**

## feat: bootstrap.sh + systemd user unit (#2)

- What: added `deploy/bootstrap.sh` and `deploy/uvc-lab.service`, spec §11
  step 4. The script runs on the box as the target user and covers design
  steps 3-9, each as check -> act -> verify: environment (hard-stops unless
  `aarch64`, requires a reachable user systemd manager, reports avahi/mDNS
  availability without installing anything), uv (astral installer into
  `~/.local/bin` only when absent), python (system `python3` >= 3.10, else
  `uv python install` — never apt), payload presence + VERSION marker write
  (the push-or-skip decision against the marker stays app-side), `uv sync`
  followed by an import check of cv2/fastapi/uvicorn from the venv, unit
  install (template rendered with `sed s/@PORT@/`, content-compared before
  overwrite, `daemon-reload` + `systemctl --user cat` verify only when it
  actually changed), and linger (tries `sudo -n`, otherwise prints the one
  command and exits 3 so the app knows to run its `sudo -S` path — the script
  never touches passwords). Sets `XDG_RUNTIME_DIR` and prepends
  `~/.local/bin` itself, the two non-interactive-SSH traps. The unit binds
  loopback only, runs `.venv/bin/python` directly (not `uv run`, which could
  re-resolve at start), has no `[Install]` section so enabling is impossible,
  and sets `Restart=no` so a crash surfaces instead of re-grabbing
  /dev/video* in a loop. `.gitattributes` pins both files to LF — the
  Windows working copy is CRLF, which would break the shebang on the box —
  and the script carries the executable bit in the index.
- Why: step 4 is the last piece that needs no Electron; with it, a bare box
  becomes start/stop-able by hand over SSH, which is exactly the state the
  app's provision step (step 7) automates later. The user asked for it now
  because the Jetson is off and unreachable until they return, so offline
  steps go first and the hardware-gated verifications batch up for one
  session at the box.
- How verified: functionally in WSL Ubuntu 24.04 (real systemd) under a
  throwaway `$HOME=/tmp/uvclab-bt` with four shims on PATH — `uname -m` ->
  aarch64, `systemctl` (show-environment/daemon-reload ok, `cat` = unit file
  exists), `loginctl` -> Linger=no, `sudo` -> fail — plus a pre-installed
  x86 uv so the aarch64-faked installer branch is skipped. Fresh run passed
  3-8 and exited 3 at linger with the correct instruction; re-run was
  idempotent (unit "already installed", VERSION rewritten, `uv sync` no-op);
  `--port 18105` re-rendered and reinstalled the unit; and the unit's exact
  ExecStart line started the server, whose `/api/health` returned the
  VERSION bootstrap had written and `/api/rig` 404'd as expected. The
  harness initially copied only 5 payload files and the server failed on
  `import bench_uvc_capture` — a harness gap, not a script bug (the real
  push is `git archive` of the whole repo), fixed by copying all `*.py`.
  Still pending on the real Jetson: the aarch64 path, real user-manager +
  linger behavior, and the uv install branch.

## feat: desktop 뼈대 — electron-vite + React + TS (#2)

- What: spec §11 step 5 — the `desktop/` skeleton with electron-vite 5 +
  React 19 + TypeScript: the main/preload/renderer boundary and a placeholder
  screen. Main creates one window with `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`, routes `window.open` to the OS
  browser, and serves a single `app:info` IPC handler. Preload exposes one
  `labDesk` object via contextBridge — the spec §9 channels get added there as
  their main modules land — and the renderer-side type mirror is hand-kept in
  `env.d.ts` because the preload file depends on Node types. The renderer is
  the locked-in stack: TanStack Router (code-based; hash history, since the
  packaged renderer loads from `file://` where a path history never matches
  `/`), TanStack Query (the `app:info` fetch), and zustand installed for later
  steps. The Home route shows the empty state and the app/Electron/Node
  versions fetched over the bridge. `.gitattributes` gains
  `desktop export-ignore` so the `git archive` payload pushed to the Jetson
  never carries the laptop app. electron-builder packaging is deliberately not
  part of this step (design: skeleton + empty screen).
- Why: step 5 is the first Electron step and the base steps 6-9 build on; the
  design fixes the layout (`src/main`, `src/preload`, `src/renderer`,
  `electron.vite.config.ts`), so it is laid down exactly. vite is pinned to
  `^7` (with `@vitejs/plugin-react` `^5`) because npm resolved vite 8 by
  default while electron-vite 5.0.0's peer range stops at vite 7.
- How verified: success criterion set up front — typecheck + build pass, and a
  dev run proving the renderer → preload → main IPC roundtrip. `npm run
  typecheck` (strict tsc over both node and web configs) and
  `electron-vite build` pass clean. Dev smoke test with
  `ELECTRON_ENABLE_LOGGING=1` and a temporary console line in Home:
  `[main] window loaded` fired and the renderer logged `[smoke] app:info
  {"version":"0.1.0","electron":"43.4.1","node":"24.18.1"}` — window shown,
  preload bridge live, roundtrip complete, no error lines (the doubled log is
  StrictMode's double render). The temporary line was then removed and
  typecheck + build re-run on the committed code. One install hiccup worth
  recording: the first `npm install -D` failed on ERESOLVE (vite 8) and left
  `electron` in node_modules without its binary, so the retried install
  skipped postinstall and `npm run dev` died with "Electron uninstall"; fixed
  by running `node node_modules/electron/install.js` by hand.

## feat: main 탐색 — 4경로 후보 수집 + 병합 (#2)

- What: spec §11 step 6 — `desktop/src/main/discovery.ts` plus its wiring.
  Phase 1 of the two-phase discovery: the four wiring routes run in parallel
  each cycle (USB direct = TCP-22 probe of `192.168.55.1`; mDNS = persistent
  `bonjour-service` `_ssh._tcp` browser, which covers same-LAN and link-local
  direct alike; Tailscale = `tailscale status --json` filtered to online Linux
  peers, `relayed` = no direct path in `CurAddr`, tailnet never scanned; subnet
  scan = SSH-banner sweep of the laptop's /24s and, only when an interface
  actually sits in it, the link-local /16 — run solely at startup/explicit
  rescan when the cheap routes found nothing). Manual add/remove by address is
  the required escape hatch. Candidates merge into `DiscoveredJetson`
  (id/identified/routes, routes ordered USB > mDNS > lan-scan > manual >
  Tailscale); identity comes from an injectable `identify` hook that step 7's
  ssh.ts will supply, so entries are provisional (address-keyed) until then —
  mDNS/tailscale names are display-only per the design. main pushes snapshots
  over `discovery:changed`; `discovery:list/scan/addManual/removeManual` are
  invoke channels; preload/env.d.ts mirror the surface; Home lists entries with
  route badges plus rescan/manual-add controls (real cards are step 9). Route
  expiry is cycle-stamped so USB unplug drops that route while a card with
  other live routes survives; mdns follows goodbye packets.
- Why: step 6 is the first main-process module and the base the SSH/provision
  steps attach to. `discovery.ts` deliberately imports no electron API so the
  collection/merge logic is verifiable under plain Node, and the design's
  warning that mDNS/tailscale names can differ from the real hostname is
  enforced by construction: nothing but the box's own answer can merge two
  routes into one Jetson.
- How verified: success criterion set up front — (1) typecheck + build, (2)
  pure logic offline, (3) dev-run IPC roundtrip. `npm run typecheck` and
  `electron-vite build` pass clean on the committed code. A plain-Node check
  script (Node 24 type stripping, no test framework added) passed 8/8:
  tailscale parsing against this laptop's real CLI output (logged-out backend:
  `BackendState "NoState"`, `Peer null` → no routes) and a synthetic Running
  sample (online-linux filter, relayed derivation), scanTargets /24 + link-local
  gating (self excluded, the real box's `169.254.203.230` inside the swept
  band), mapPool order/concurrency, tcpProbe/readSshBanner against local
  listeners, and merge via a stub identify (two addresses → one identified
  entry; null-identify stays provisional; manual remove/reject). The banner
  check crashing the first test run exposed a real bug: probe sockets used
  `once('error')`, so a second error (late RST on Windows) would have been an
  unhandled 'error' crashing the whole main process — fixed with `on('error')`
  + settled guard. Dev smoke with temporary console lines: `[main] window
  loaded`, `discovery:list` roundtrip, `addManual('10.77.77.77')` →
  `discovery:changed` with the manual card → `removeManual` → empty list, zero
  error lines; temp lines removed and typecheck + build re-run. Pending at the
  box: actually discovering the Jetson per route (USB / mDNS / link-local /
  Tailscale) — batched with the step-2 and bootstrap verifications.

## feat: main SSH + 프로비저닝 — 9단계 상태 머신 (#2)

- What: spec §11 step 7 — `desktop/src/main/credentials.ts`, `ssh.ts`,
  `provision.ts` plus their wiring. The credential store treats safeStorage as
  an injected cipher and owns `userData/credentials.json` (atomic tmp+rename;
  memory-only when encryption is unavailable or the Linux backend is
  basic_text — the design's no-plaintext rule). Its IPC is inward-only:
  `credentials:canPersist/has/set/delete`, and `has` returns the username
  alone — no channel can read a password back out of main. `ssh.ts` wraps ssh2
  (password auth with keyboard-interactive fallback, exec with line-streaming
  and stdin piping, `SshAuthError` distinguished from network failure), pools
  one session per Jetson id, and provides discovery's phase-2 `identify` hook:
  stored credentials are tried and the box's own `hostname` becomes the id,
  with failures negative-cached per credential set so a foreign sshd is not
  sprayed every 10s cycle while newly stored credentials retry at once.
  `provision.ts` implements the design's 9 steps — tcp probe, auth
  (`needs-auth` phase distinct from `failed` so the renderer knows to prompt),
  the app-side VERSION push decision with `git archive HEAD` streamed into
  remote `tar -x`, server-port selection before bootstrap renders the unit
  (an active unit keeps its port; otherwise walk 18100-18109 past `ss -ltn`),
  bootstrap streamed line-by-line (`[N/9]` markers → progress, `FAIL:` → the
  error), and on exit 3 the linger sudo: `sudo -k -S -p '' -v` with the SSH
  password first, stored `sudoPassword` as the one fallback, each exactly
  once, then `sudo -n loginctl enable-linger`; unusable sudo yields
  `needs-sudo` with the one-line manual command. `startServer`/`stopServer`
  run `systemctl --user` (XDG_RUNTIME_DIR exported) and verify with
  `curl /api/health` on the box's own loopback. IPC: `provision:run` invoke,
  `provision:changed`/`log:line` push; preload/env.d.ts mirror the surface.
  Main-side relative imports gained `.ts` extensions
  (`allowImportingTsExtensions`) so the electron-free modules load under
  plain Node.
- Why: step 7 turns a discovered address into a provisioned box and gives
  discovery its identity source — entries stop being provisional exactly when
  the box itself answers. The password rules are structural, not conventional:
  renderer-inward IPC only, `sudo -S` stdin (never argv, where the Jetson's
  `ps` would show it), one attempt per candidate password (repeats hit sudo's
  warning and auth.log).
- How verified: success criterion set up front — (1) typecheck + build, (2)
  the state machine offline against a real SSH protocol peer, (3) dev-run IPC
  roundtrip. `npm run typecheck` and `electron-vite build` pass clean on the
  committed code. A plain-Node script (`node --experimental-transform-types`,
  no framework) drives a scripted ssh2 `Server` on localhost as the fake
  Jetson and passed 11/11: credential round-trip with no plaintext bytes on
  disk and nothing persisted without encryption; exec stdout/stderr/exit/stdin
  delivery and `SshAuthError` typing; the identify negative cache (failed host
  not re-attempted while the credential set is unchanged, retried after it
  changes, hostname becomes the id, session adopted into the pool); the full
  provision run — tar push byte-count equal to `git archive HEAD`, port walk
  to 18101 past a used 18100, bootstrap exit 3, sudo password arriving on
  stdin only, ready; version-match skipping the push; sudo failure stopping
  after exactly one attempt with the manual command surfaced; a bootstrap
  `FAIL:` line becoming the reported error; wrong/missing credentials
  reporting `needs-auth`; and an active unit keeping its rendered port. Dev
  smoke with temporary console lines: window loaded, `credentials:canPersist`
  true under real DPAPI, has → null, set → `{"user":"smoke"}`, delete → null,
  zero error lines, and `%APPDATA%\uvc-lab-desk\credentials.json` left with
  empty entries. Pending at the box (batched): a real end-to-end provision —
  aarch64 bootstrap path, real sudo/linger, uv install branch — and
  `identify` merging the real routes.

## feat: main SSH 터널 — 로컬 포워드 입구 (#2)

- What: spec §11 step 8 — `desktop/src/main/tunnel.ts` plus its wiring, and
  an `SshSession.forward` wrapper around ssh2 `forwardOut`. `TunnelManager`
  keeps one tunnel per Jetson id: a TCP server bound to laptop loopback whose
  every connection is piped through the pooled SSH session into the Jetson's
  own loopback at the provisioned `serverPort`. Local ports follow the
  design's laptop-side rule — 18101-18109 in order (EADDRINUSE/EACCES walk),
  then bind port 0 so the OS picks — and the live URL travels to the renderer
  either way (`tunnel:open/close/list` invoke channels, `tunnel:changed`
  snapshot push; preload/env.d.ts mirror the surface). The SSH session is
  looked up per incoming connection through `SshPool.acquire`, so a dropped
  session reconnects from stored credentials on the next request; with no
  session and no credentials the connection is dropped and the renderer's
  fetch fails visibly. Reopening the same target is a no-op; a changed host
  or server port replaces the tunnel.
- Why: design section 3 — the renderer always talks to
  `http://127.0.0.1:<localPort>` whichever route (USB/mDNS/LAN/Tailscale) is
  live, and the Jetson opens no port on its network. Per-connection session
  lookup is what makes the design's "reconnection is the app's job" hold
  without a reconnect loop: the entrance stays up, and the first request
  after an SSH drop either heals the tunnel or fails where the card can show
  it.
- How verified: success criterion set up front — (1) typecheck + build, (2)
  the relay offline against a real SSH protocol peer, (3) dev-run IPC
  roundtrip. `npm run typecheck` and `electron-vite build` pass clean on the
  committed code. A plain-Node script (`node --experimental-transform-types`)
  drives a scripted ssh2 `Server` whose `tcpip` handler bridges into a local
  echo server, and passed 9/9: bytes round-trip through the real direct-tcpip
  channel with the destination asserted as `127.0.0.1:<serverPort>`; a second
  device takes 18102; a busy band port is walked past; the exhausted band
  falls back to an OS-assigned port that still round-trips; reopening the
  same target pushes no change; a changed server port replaces the tunnel and
  forwards to the new destination; a dropped SSH session reconnects
  transparently from stored credentials (a fresh login observed on the mock);
  no credentials drops the connection without crashing; close refuses the
  entrance afterwards and `closeAll` empties the list. Dev smoke with
  temporary console lines: window loaded, `tunnel:list` [], `tunnel:open`
  ('smoke-box', 127.0.0.1, 19999) returned the 18101 entrance with its URL
  and pushed `tunnel:changed`, a renderer `fetch` against it failed as
  expected (no credentials), `tunnel:close` emptied the list — zero error
  lines beyond that deliberately provoked fetch failure. Pending at the box
  (batched): real HTTP through the tunnel to `serve_uvc_lab.py`, per route.

## feat: renderer 장비 카드 + 로그 패널 (#2)

- What: spec section 11 step 9 — the renderer's device cards and log panel
  (`store.ts`, `bridge.ts`, `DeviceCard.tsx`, `LogPanel.tsx`, Home rewired),
  plus two small main-side additions the card needed:
  `ProvisionRunOptions.auth.sudoPassword` (flows into the linger sudo
  candidates, saved alongside when `save`) and a `credentials:setSudo` IPC
  channel that merges a sudo password into an existing entry. A zustand
  vanilla store mirrors main-pushed state (discovery, provision keyed by
  host, tunnel snapshots, logs capped at 500) plus per-id server phase and
  chosen route; bridge.ts subscribes to the IPC pushes exactly once at module
  level. The card renders the design's list: state dot, health version, all
  live routes (click to switch the one in use, relay flagged), provision
  phase/step, live tunnel URL with copy, install/reinstall(forcePush),
  start (systemctl + health + tunnel open), stop (tunnel close + systemctl).
  `needs-auth` and `needs-sudo` are inline forms — the sudo one shows the
  manual command and, when credentials are stored, sends only the sudo
  password through setSudo so the SSH password never re-enters the renderer.
- Why: step 9 gives provisioning and the tunnel their UI — until now every
  main capability existed but nothing could drive it. The two main-side
  additions exist because the design requires the sudo password to be
  collectable in-app: without them the renderer had no path to hand a sudo
  password over without also knowing the stored SSH password, which the
  design forbids it from ever seeing. Ids prefer `provision.jetsonId` over
  the card id so actions work in the window between a provision identifying
  the box and discovery's next identify cycle renaming the card.
- How verified: success criterion set up front — (1) typecheck + build, (2)
  logic offline, (3) a DOM-driven dev smoke. `npm run typecheck` and
  `electron-vite build` pass clean on the committed code. Plain-Node checks
  (6/6): store logic (provision keyed by host, log cap + clear, tunnel
  snapshot replace, per-id server/route state, provisionBusy table), the
  setSudo merge contract (ssh password untouched, target must exist), and a
  scripted ssh2 Server run proving auth.sudoPassword rides sudo's stdin as
  the one fallback after the SSH password and is persisted by save. Dev
  smoke: a mock Jetson (real ssh2 server on 127.0.0.1:22, exec answers,
  direct-tcpip bridged to a local /api/health HTTP server) plus a temporary
  driver clicking the real DOM — manual add, install, needs-auth form filled
  and submitted, ready with server port 18100 shown, 9 bootstrap lines in
  the log panel, start turning the dot green with tunnel URL
  `http://127.0.0.1:18101` on the card, a renderer fetch through that tunnel
  returning the mock's health JSON, stop clearing tunnel and dot — zero
  error lines; driver removed before commit. The first smoke run exposed a
  real-world hazard worth recording: discovery listed the actual LAN gateway
  (192.168.10.1, ssh open) first, the driver clicked that card, and one
  failed auth attempt went to the real box before the timeout — the driver
  now selects the mock's card by name. One transient vite dep-optimize
  reload (new zustand import) produced a one-off React error on first boot
  only; it does not reproduce with a warm cache and is not committed code.

## feat: rig 등록 화면 + 배선 다이어그램 (#2)

- What: spec section 11 step 10 - `desktop/src/renderer/src/rig.ts` and
  `RigScreen.tsx` (the registration screen and the wiring diagram),
  `desktop/src/main/jetson-http.ts` with the `devices:list` / `rig:get` /
  `rig:save` channels behind it, a `구성` link on the device card and a
  `/rig/$jetsonId` route, plus three server-side changes in
  `serve_uvc_lab.py`: `DeviceBroker` becomes readers/writer so previews run
  concurrently while still yielding to one exclusive user, `stream_stats`
  becomes per index (the no-index call keeps answering the old flat shape for
  `uvc_lab.html`), and `/api/devices` returns `idPath`. Main relays HTTP to
  the box as `curl` over the pooled SSH session, so nothing here depends on an
  open tunnel and no port is opened on the Jetson's network; `rig:get` turns
  the server's 404 into null because section 5's `no-rig` is a state, not an
  error. `rig.ts` is React-free: the seven-state match, the hub-moved proposal
  (only when every bound port shifts by the same prefix and the per-port
  control profiles still agree), the section 6.4 signal rules, and the port
  slots the diagram draws - empty ports included.
- Why: this is the step the whole spec exists for - a rig is what lets the app
  call two cameras an error instead of a fact. Three decisions are worth
  recording. The registration screen previews every camera at once (section 4),
  which the old broker made impossible: it held one lock for the whole stream,
  so the second preview would have waited out its timeout and reported a busy
  camera. Unbound cameras auto-bind only when exactly one camera and exactly
  one free port make the answer unambiguous, because section 1.1 leaves the app
  no basis to decide between two identical cameras - anything else asks. And
  TRG is gated on both the trigger source pin and the control profile, so the
  screen refuses the declaration that section 1.5 proved impossible (P4 has no
  trigger firmware) before any wiring work is done, not after.
- How verified: success criterion set up front - (1) typecheck + build, (2)
  logic offline, (3) a DOM-driven dev smoke. `npm run typecheck` and
  `electron-vite build` pass clean on the committed code. Python checks 5/5
  against the rewritten broker: two previews genuinely overlap, an exclusive
  user enters only after they drain and sees the preempt flag cleared, a
  preview during an exclusive section fails as busy rather than hanging, and
  the stats API answers per index / missing / no-index-flat. Plain-Node checks
  15/15: every one of the seven match states including hub-moved accepted and
  the same shift refused when one port's profile disagrees, GND following the
  other signals, the TRG gate (no pin / webcam-std / unknown profile), the port
  slots with the gap at P3, `markOf`/`usbRootOf`/`bindCandidates` against the
  measured Jetson strings, and `jetson-http` over a scripted ssh2 server -
  status parsed off the last line, 404 surfaced as `JetsonHttpError`, a Korean
  rig PUT arriving byte-identically on stdin, and a non-zero `curl` exit
  reported as a plain error. Dev smoke through the real DOM against the mock
  Jetson (ssh2 server on 127.0.0.1:22 answering the curl device/rig commands
  and serving a still JPEG through the direct-tcpip bridge): install -> start
  -> `구성` -> `no-rig` -> ports drawn P1 P2 P3(비어 있음) P4 -> import +
  labels -> P1 TRG check turning GND on and locking it -> the 1.8V warning ->
  P4's TRG disabled with its reason -> save (the mock logged
  `cameras=3 wiring=usb-0:1.1:TRG+GND trigger=BOARD7 usbRoot=platform-3610000.usb`)
  -> re-detect showing `구성 일치` -> the preview image decoding through
  the tunnel; zero error lines, driver removed before commit. The smoke also
  caught a real bug: the card links by the id provision reported while the
  screen looked the Jetson up in the discovery list, so the screen said "not in
  this list" until discovery's next identify cycle - it now falls back to the
  host of the provision that reported that id. Pending at the box (batched):
  the real three-camera registration, real previews, and the match against a
  rig saved on the Jetson itself.

## feat: 랩 화면 — 프리뷰·모드·파라미터·벤치마크 (#2)

- What: spec section 11 step 11 - `desktop/src/renderer/src/lab.ts` and
  `LabScreen.tsx` behind a `/lab/$jetsonId` route and a `랩` link on the device
  card, the `lab:*` relay channels (`modes` / `presets` / `streams` /
  `controls` / `setControl` / `runStart` / `run`) with POST support in
  `jetson-http.ts`, and the server side they call: `uvc_devices.py` gains a
  general V4L2 control layer (`query_controls`, `set_control`) and
  `serve_uvc_lab.py` gains `/api/modes`, `GET`/`POST /api/controls`,
  `/api/streams`, an `fps` stream parameter with the requested/observed pair in
  the stats, and `rigStatus` on every run record. `STATUS_LABEL` and
  `issueMessage` moved from `RigScreen.tsx` into `rig.ts` so both screens read
  the match the same way; the rig screen now links to the lab screen when the
  match is `ok`.
- Why: this is the screen the earlier steps were for, and three decisions in it
  are not obvious. (1) Everything except the preview goes through the same
  SSH relay as devices/rig rather than the tunnel, so the screen works before a
  tunnel exists and the renderer never learns which transport carried the call
  (spec section 9); the preview is the exception because an `<img>` needs a URL
  it can fetch itself. (2) Control ranges are read from the device on every
  query and the write reports back the value the driver kept, not the one that
  was asked for - the same rule section 7.2 states for modes, applied to
  controls, because section 1.5 already measured two cameras of the same
  nominal model disagreeing on the same control's range. (3) The section 5
  gate lives on this screen: anything but `ok` blocks it, the only way past is
  an explicit "무시하고 진행", and from then on every run carries that status so
  no number is left without the configuration it came from. Previews are
  dropped for the duration of a run because the broker preempts them anyway and
  an `<img>` does not reconnect on its own - the screen re-issues the URLs with
  a fresh nonce when the run ends.
- How verified: success criterion set up front - (1) typecheck + build, (2)
  logic offline on both sides, (3) a DOM-driven dev smoke. `npm run typecheck`
  and `electron-vite build` pass clean on the committed code. Python checks 9/9
  with no camera and no Linux: every ioctl request number and struct size
  recomputed from the kernel's `_IOWR` formula, `queryctrl` decoding (name,
  signed ranges as exposure reports them, a zero step floored to 1), the
  DISABLED/GRABBED flags, the control ids against videodev2.h, the guards on
  `set_control`, `/api/modes` serving the box's own candidate lists,
  `/api/controls` (supported flag, device node, driver-kept value, EINVAL as
  409), `/api/streams` alongside the unchanged flat stats, and a run recording
  the `rigStatus` it was started under. Two of those caught real bugs before
  any hardware could: `VIDIOC_G_CTRL`/`S_CTRL` were written with their decimal
  request numbers pasted into hex (0x...27/28 instead of 0x...1B/1C), which
  would have made every control read fail on the box; and the pre-existing
  `queryctrl` decode read flags from `reserved[0]` (index 8, not 7), so a
  disabled control would have been accepted with a meaningless range - both
  fixed here. Plain-Node checks 10/10: preview URLs (nonce, fps only when
  asked), the mode delta in both directions, clamping against a device range of
  16..160 step 8 and a negative exposure range, preset defaults and per-type
  coercion, run-log slicing, the gate across all seven states, and jetson-http's
  POST body on stdin plus the new path guard refusing a path with shell
  metacharacters. That guard's test also caught `parseNumberList('')` returning
  `[0]` - an empty camera list would have meant "camera 0", not "none". Dev
  smoke through the real DOM against the mock Jetson: install -> start -> `랩`
  -> the gate reporting `no-rig` with the lab sections hidden -> `무시하고
  진행` -> 3 camera panels -> preview decoding through the tunnel -> request
  1920x1200 MJPG 60 answered with `관측 1280x720 YUY2 30fps` and the
  substitution spelled out on all three fields -> gain slider carrying the
  device's own 16..160 step 8 -> a write of 500 clamped to 160 and displayed as
  the 128 the mock's driver kept -> a run pausing the previews, its log lines
  arriving in the shared panel, the result rendered with `rig: no-rig`, and the
  previews reconnecting afterwards; zero error lines, driver removed before
  commit. Pending at the box (batched): the V4L2 control ioctls against real
  cameras, a real driver substitution, and a preset run preempting live
  previews. Section 7.4 (trigger verification) is out of this step's scope and
  recorded above as needing its own.

## feat: 테스트 프로필 + requires 게이트 (#2)

- What: spec section 11 step 12 - `desktop/src/renderer/src/profiles.ts` (the
  gate and the profile-to-parameters translation) and `ProfilePanel.tsx` (the
  editor, rendered inside the lab screen), plus what they need underneath:
  `GET`/`PUT /api/profiles` on `serve_uvc_lab.py` storing
  `~/.uvc-lab/profiles.json`, a `profileId` on every run record, the
  `lab:profiles` / `lab:saveProfiles` relay channels, and `profileId` carried
  through `lab:runStart`. `LabScreen` now has one `startRun` used by both the
  bench panel and a profile, shows a `프로필: <id>` badge next to the existing
  `rig: <status>` one, and finally surfaces a failed run poll instead of
  rendering nothing.
- Why: section 8's `requires` is the whole point of the step - an impossible
  combination has to be refused *while the profile is on screen*, not after it
  has produced numbers. The decisions that are not obvious: (1) profiles live
  on the Jetson next to `rig.json`, because a profile names port paths and a
  port path is a fact about that box, not about a laptop; (2) a camera marked
  `trigger: "hardware"` is refused even when firmware and wiring are fine,
  because nothing here can drive the FSIN line yet (section 7.4) and running it
  anyway would file free-running numbers under a trigger profile; (3) a run is
  blocked while the editor is dirty, since the result records the profile id
  and the stored profile must be the thing that produced the numbers; (4) the
  camera block is the authority for index/resolution/fourcc/fps, so those are
  not offered again as free parameters, and anything the chosen preset has no
  knob for is reported as a dropped value rather than silently ignored.
- How verified: success criterion set up front - (1) typecheck + build, (2)
  both sides offline, (3) a DOM-driven dev smoke. `npm run typecheck` and
  `electron-vite build` pass clean on the committed code. Python checks 6/6
  (an absent profiles.json reads as an empty set rather than a 404, the PUT
  round-trips atomically with Korean intact and no `.tmp` left behind, a
  hand-edited bare list is still readable, every validation refusal leaves the
  saved file untouched - including duplicate ids, which would make two setups
  indistinguishable in the run records - and a run records the profile it came
  from); step 11's 9/9 still pass. Plain-Node checks 12/12 on the gate: the
  spec's own example refused with its own message (`우 카메라(P4)는 트리거
  모드를 지원하지 않습니다 ... webcam-std`), wiring and pulse-source
  refusals separated from firmware ones, a runnable profile turning into exactly
  the expected preset parameters, cameras that disagree on a mode refused for a
  single-mode preset, a single-camera preset refusing two cameras, absent and
  held cameras named the way the rig screen names them, dropped-field warnings,
  and id rules. Dev smoke through the real DOM against the mock Jetson: install
  -> start -> 랩 -> past the section 5 gate -> a box with no profiles saying so
  -> 새 프로필 seeded with the three detected ports -> the section 8 example
  built in the editor and refused with 4 reasons and the run button disabled ->
  P4 dropped and the triggers set free -> gate ok but the run still blocked
  until saved -> saved to the box and listed -> run started with
  `indices [0, 2]` and the camera block's mode -> result showing both
  `프로필: sync-2cam-free` and `rig: no-rig`, its log in the shared panel.
  Three consecutive runs, zero error lines, driver removed before commit.
  Pending at the box (batched): the gate against the real three cameras, where
  the trigger example must refuse port 4 on its own evidence.

## fix: 링크로컬 경로 접속 — 출발지 주소 경쟁과 대역 전수 스캔 제거 (#2)

- What: added `desktop/src/main/link-local.ts` and routed every link-local
  connection through it — `tcpProbe`/`readSshBanner` (discovery.ts) now open
  their socket via `openSocket`, and `SshSession.connect` asks `sourceFor` for
  the address to bind. `scanTargets` no longer expands the 169.254.0.0/16 band.
  The design's discovery section was corrected in three places to match.
- Why: found at the box, on the route the user actually uses. Two separate
  faults sat on top of each other. (1) Every adapter holding an APIPA address
  contributes an on-link 169.254.0.0/16 route and Windows takes the lowest
  interface metric; a Tailscale adapter that is installed but logged out sits
  there at metric 5 against the ethernet adapter's 25 and swallows the whole
  band, so the app could not reach a Jetson one cable away. (2) The fallback
  scan then tried to brute-force that band, and its socket storm was what
  actually killed the first real provision — the app starved its own connection
  to the box it was installing to. The mDNS route could not cover for either:
  the box advertises no services at all, so `_ssh._tcp` finds nothing and only
  manual add gets a first contact.
- How verified: measured, not reasoned. Plain `connect()` to the Jetson's
  169.254.203.230:22 times out while the same connect bound to the ethernet
  adapter's own link-local address succeeds — reproduced in Node before the
  fix and again through the app after it, which then read the real SSH banner
  (`SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.16`) and completed a full provision
  over that route. The learned source makes the second probe 2ms instead of
  1.6s, a refused port keeps the learned source instead of re-racing, and a
  dead link-local address still fails fast (468ms). The band scan was timed
  before removal: 65,528 targets, 3,020 seconds, nothing found. avahi's silence
  was confirmed on the box (`/etc/avahi/services/` empty,
  `publish-workstation=no`) with `avahi-resolve` still answering for the
  hostname, which is why the design now says the mDNS route needs the box to
  advertise before it can work.

## fix: sudo 비밀번호를 명령과 같은 exec 채널로 (#2)

- What: `enableLinger` no longer validates with `sudo -k -S -p '' -v` in one
  exec and then runs `sudo -n loginctl enable-linger` in the next. Each
  candidate password now rides the stdin of the command it authorises,
  `sudo -k -S -p '' loginctl enable-linger <user>`, and a failure that is not a
  rejected password stops the loop instead of burning the next candidate. The
  design's sudo section records the rule and why the old shape could not work.
- Why: the user hit this at the box — the app asked for a sudo password and
  refused every correct one, with no way past the install. sudo keys its
  timestamp to the tty (`timestamp_type=tty` is the default), and a
  non-interactive SSH exec has no tty, so each exec channel falls back to a
  record of its own. A validation in one channel is invisible to `sudo -n` in
  the next, whatever the user types.
- How verified: on the box, over SSH, before touching the code.
  `sudo -k -S -p '' -v` with the right password on stdin returns 0, and the
  very next exec running `sudo -n -v` answers "sudo: a password is required"
  (exit 1); the same password on the stdin of `sudo -k -S -p '' <command>`
  runs it. `/etc/sudoers` and `/etc/sudoers.d/` set no `tty_tickets` or
  `timestamp_type` explicitly, so this is stock Ubuntu behaviour, not a local
  policy. After the fix the app's install reached `ready` with `serverPort
  18100`, and the box reports `Linger=yes`.

## fix: 장치 열거가 프리뷰를 죽이지 않게 + 응답 없는 카메라 보고 (#2)

- What: three changes that hang together. (1) `/api/devices` keeps the last
  inventory and serves it while previews are live, taking the cameras only for
  an explicit `?refresh=1`, and says which happened with `X-Devices-Cached`;
  the renderer passes that flag from 다시 감지 alone, and its QueryClient stops
  refetching on window focus. (2) `_probe_open` runs on its own thread with an
  8s deadline (`PROBE_TIMEOUT_S`) and records why it gave up in a new
  `probe_error` field, surfaced as `probeError` through `/api/devices` and
  rendered as "응답 없음" (vs "사용 중") in the profile panel and the browser
  page. (3) A preview tile that never decodes a frame says so instead of
  sitting blank, a stream that dies of a RuntimeError keeps its message in the
  stream stats, and the rig screen tells a 409 (cameras held) apart from an
  unreachable server.
- Why: all three came out of the same afternoon at the box. Enumeration opens
  every camera and costs ~18s for three of them, so preempting previews for a
  routine refetch killed the previews and eventually answered 409 — and the
  refetch was triggered by nothing more than the window regaining focus. Then a
  camera whose USB link was failing left its node in place and blocked in
  open/read forever, which held the broker's exclusive lock and wedged the
  whole server: every request answered "camera is busy" until the unit was
  restarted. The same camera later enumerated, opened, and sent nothing, which
  an `<img>` shows as a blank rectangle with no error at all.
- How verified: on the real box. Before the cache change, `/api/devices` during
  a single preview took 18s and 409'd with three; after it, the same call
  answers in 5ms while previews keep running, and `?refresh=1` still re-probes.
  The probe deadline was checked against the actually-broken camera:
  enumeration returns in 16s with that device marked `probeError: "timeout"`
  instead of never returning. The stall message appeared on the real tile of a
  camera that was streaming nothing, and — after the tile was changed to keep
  looking rather than judge once — cleared itself on a slow camera that took
  longer than the deadline and then streamed fine. One limit is recorded rather
  than fixed: a blocking V4L2 read cannot be cancelled, so a camera that dies
  mid-stream holds its capture until the server is restarted.

## fix: 서버 상태는 장비에 묻고, 살아 있으면 터널도 연다 (#2)

- What: `serverStatus(session, port)` in provision.ts (`systemctl --user
  is-active` plus `/api/health`), exposed as the `server:status` IPC channel
  and `window.labDesk.server.status`. The device card polls it every 10s for
  an installed box and reconciles its own phase from the answer instead of
  from what this app last did; the same effect opens the tunnel when the
  server is running and no tunnel exists. The design's lifecycle section gains
  the rule.
- Why: both fell out of the Jetson reboot that the USB fault forced. After the
  box came back the card still read "running" and left 시작 disabled, so the
  only way to restart the server was to press 정지 first — the app was showing
  a memory, not a fact, and the same would happen whenever anyone stops the
  unit outside the app. The tunnel had the mirror-image problem: it only ever
  opened as a side effect of pressing 시작, so a server that was already
  running left every preview reading "터널 없음" with no button that would fix
  it.
- How verified: against the real reboot. With the box freshly rebooted and the
  server down, the card now reports not-running and 시작 comes back enabled
  (`startDisabled: false`), and with the server already up the tunnel appears
  by itself — `tunnel.list()` returns `18101 -> 18100` without anyone pressing
  시작, and the rig screen's previews render through it. The poll is one
  `systemctl --user is-active` over the pooled SSH session per interval, and it
  never overwrites a start/stop this card is in the middle of.

## fix: 창이 뒤에 있어도 실행 폴링을 계속한다 (#2)

- What: the lab screen's run query sets `refetchIntervalInBackground: true`.
- Why: a measurement runs on the Jetson, not in this window, but React Query
  pauses interval refetches while the window is not focused. The run therefore
  froze at "running" the moment the operator looked at another window — and
  since the focus refetch is deliberately off (it would seize the cameras), it
  did not catch up on return either.
- How verified: at the box, an `identify` run finished on the Jetson in 11.5s
  (`status: done`, `rigStatus: missing` recorded) while the app kept showing
  "running"; querying the same run over IPC returned `done`, so the data path
  was fine and only the poll had stopped. With the window focused the badge
  flipped to 완료 and the result table appeared.

## chore: 실물 검증용 CDP 시임 (#2)

- What: `UVC_DEBUG_PORT=<port> npm run dev` appends Chromium's
  `remote-debugging-port` switch in main. Unset, nothing is opened.
- Why: step 13 has to exercise the real DOM against a real Jetson — the rig
  screen's detection, the section 5 gate, the section 8 profile gate — and
  clicking those by hand for every restart of the app is not repeatable. The
  earlier dev smoke used a driver that was deleted before committing; the user
  chose to keep this seam so the next round of hardware verification can drive
  the same path.
- How verified: used for the whole of today's verification. With the variable
  set, `/json/list` offers the renderer target and a driver script evaluates in
  the page; without it, Electron opens no debugging port.
