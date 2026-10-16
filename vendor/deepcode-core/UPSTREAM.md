# Vendored: @vegamo/deepcode-core

- Source: https://github.com/lessweb/deepcode-cli/tree/03c7ebbfa1b7129628c30a3abbcbb776aa04ac1a/packages/core
- Version: 0.4.3 (commit `03c7ebbfa1b7129628c30a3abbcbb776aa04ac1a`)
- License: MIT (see LICENSE)
- Copied: `src/` (without `src/tests/`) and `templates/`.
- Local patches in `vendor/patches/` (applied by the sync script):
  - `scrub-api-key.patch`: the bash tool's shell no longer inherits `DEEPCODE_API_KEY`, `DEEPCODE_PLUS_API_KEY` or the stripped `API_KEY`/`PLUS_API_KEY` from settings env.
- Retired patches, now upstream (keep the history here so a future re-vendor does not resurrect them):
  - reasoning_effort top level instead of `extra_body`: merged upstream in lessweb/deepcode-cli#370 (commit `5954625`, present since vendored commit `03c7ebb`).
  - `orchestrator.patch`: `disallowedTools` setting (tool removed from schema and docs, refused if called), and a lock file + atomic write for `sessions-index.json` so parallel runs in one project do not lose sessions.

Why vendored: `@vegamo/deepcode-core` is not published on npm.
Update: `scripts/sync-upstream.sh <ref>`, then rebuild and run the tests.
