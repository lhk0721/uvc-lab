# 12 chore: #2·#3 머지 반영과 후속 이슈 등록

## Summary
- Issue: #12
- Branch: `12-chore-merge-followup-docs`
- Umbrella: #1
- Status: in progress

## Current State

Documentation-only. #2 and #3 merged (PRs #8 and #9), their worktrees and
branches are gone, but every document that points at them still said "in
progress". This is the post-PR cleanup gate's paperwork, split out because
`main` is protected and cannot take a direct commit.

## chore: #2·#3 머지 반영과 후속 이슈 등록

What / why:

- `AGENTS.md` Recent Active Context is the first thing a new session reads, and
  it claimed the Lab Desk design was done and implementation not started. Both
  were false — the app is built, verified, and merged. A stale pointer there is
  worse than an empty slot, because it is read as current state, so the slot goes
  back to `(none)`.
- Statuses for #2 and #3 set to merged in the registry and the umbrella. NOT in
  their own management documents: the pre-commit hook refuses a branch that edits
  another issue's management doc, and both branches are gone. That status belongs
  on the issue's own branch before its PR merges, and neither did it. Their docs
  still read "in progress" and #3's still says "not pushed, not merged" — the
  registry and the umbrella are the answer until a future branch touching those
  files can correct them.
- #10 (corrupt JPEG on hub port 3) and #11 (modules ignore the requested frame
  rate) registered in the umbrella. Both came out of #3's measurements and are
  unrelated to anti-flicker: #3's fix removed the brightness swing and left both
  untouched. They have no management document yet — that comes with the branch
  that picks them up.

How verified: `AGENTS.md`, the registry and the umbrella read back with no
remaining "in progress" for #2 or #3, and the umbrella lists every open
sub-issue (#4-#7, #10-#12). The hook block above was hit for real and the two
out-of-branch edits were reverted rather than forced through with
`AGENT_KIT_SKIP`.
