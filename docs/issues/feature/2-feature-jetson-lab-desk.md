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

Next step: verify step 2 on the live Jetson, then step 4 (`deploy/bootstrap.sh`
+ `deploy/uvc-lab.service`) and onward per the 13-step order.

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
