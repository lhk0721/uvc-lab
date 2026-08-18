# 2 feature: Jetson 자동 배포 + Lab Desk 컨트롤 앱

## Summary
- Issue: #2
- Branch: `2-feature-jetson-lab-desk`
- Umbrella: #1
- Status: in progress

## Current State

Design agreed with the user and written to `docs/design/jetson-lab-desk.md`
(Korean, human-facing). Implementation has not started. Key decisions locked in:

- Laptop-side control app ("Lab Desk"): FastAPI + single HTML page, opened via
  Chrome `--app` mode (Edge fallback). No CLI — buttons only.
- Discovery order: 192.168.55.1 (USB device mode) → mDNS → subnet SSH scan.
- Provision by SSH push: `git archive` tar streamed over ssh; idempotent
  `bootstrap.sh` (apt deps, uv, `uv sync`, systemd unit installed but NOT
  enabled — no boot autostart, the Jetson is not a camera-only box).
- Server lifecycle driven from the laptop: `systemctl start/stop` over SSH.
- `serve_uvc_lab.py` gains `/api/health` (version + hostname) so discovery can
  tell provisioned boxes and version drift.
- Known constraint: `uv sync` assumes the Jetson can reach PyPI; offline wheel
  push is deliberately deferred.

Next step: implement in the commit order proposed at the end of the design doc
(health endpoint → find_jetson → bootstrap/service → lab_desk → e2e on real
hardware).

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
