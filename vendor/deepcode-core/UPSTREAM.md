# Vendored: @vegamo/deepcode-core

- Source: https://github.com/lessweb/deepcode-cli/tree/857b58c12fed11bad90704a0e32767270a1784f8/packages/core
- Version: 0.4.3 (commit `857b58c12fed11bad90704a0e32767270a1784f8`)
- License: MIT (see LICENSE)
- Copied: `src/` (without `src/tests/`) and `templates/`.
- Local patches in `vendor/patches/` (applied by the sync script):
  - `reasoning-effort-top-level.patch`: `reasoning_effort` sent top level instead of `extra_body` (DeepSeek ignores `extra_body` from the Node SDK; upstream bug).
  - `orchestrator.patch`: `disallowedTools` setting (tool removed from schema and docs, refused if called), and a lock file + atomic write for `sessions-index.json` so parallel runs in one project do not lose sessions.

Why vendored: `@vegamo/deepcode-core` is not published on npm.
Update: `scripts/sync-upstream.sh <ref>`, then rebuild and run the tests.
