# automath's Paperclip

This fork carries the customisations the automath research pipeline runs on top of Paperclip.

- `master` tracks `paperclipai/paperclip` master and is never edited directly.
- `automath` is the branch we run from: upstream master plus our changes, one commit per change, in source form
  (TypeScript) so that each one can be proposed upstream. PR branches are cut from `master`.
- The production instance currently runs the npm release (2026.1005.0) with the same changes applied to the
  installed bundle by idempotent patch scripts kept in the automath repository (`tools/paperclip/patches/`).
  Those scripts are the operational truth until this branch is built and deployed; the two are kept in step.

## Changes carried on `automath`

| # | Change | Upstream status |
|---|---|---|
| 1 | codex_local on ssh targets authenticates with the remote host's own `~/.codex/auth.json` instead of the Paperclip host's login (third-party workers keep their own Codex logins); `PAPERCLIP_CODEX_AUTH_CACHE=0` disables host-side credential caching | not proposed yet |
| 2 | heartbeat pre-dispatch credential gate skips ssh targets like sandbox targets | not proposed yet |
| 3 | agent deletion removes `cost_events` before `heartbeat_runs` (foreign-key failure on delete) | not proposed yet |
| 4 | run pools: `PAPERCLIP_RUN_POOLS="codex:2:scout,attacker-1,attacker-2,formalizer"` caps simultaneously running runs across named agents (and `PAPERCLIP_ADAPTER_CONCURRENCY_LIMITS` per adapter type), count and claim under a Postgres advisory lock at the single admission point | related: #7041, #14564, PR #14333, PR #14995 — commented, not a parallel PR |
| 5 | session codecs keep `remoteExecution` (claude_local and codex_local) | upstream PR #12930 (open), confirmed there |
| 6 | ssh session identity keyed on `remoteWorkspacePath`; codex_local skips the per-run cwd comparison on remote targets | issue #15709, PR #15710 |

Already in upstream master and therefore not carried separately: #15437 (prompt bundle key stable across
per-run instruction copies; applied to the 2026.1005.0 bundle locally as a backport until the next release).

## Why

The pipeline runs eight agents of four roles on two containers over ssh, with clean-room attackers that must not
share workspaces, two Codex seats on one subscription, and long multi-step tasks that need resumed sessions.
Each change above closes a gap that showed up in that setup; the automath repository's `tools/paperclip/README.md`
documents the operational side (environments, routines, recovery).
