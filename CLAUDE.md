# CLAUDE.md: dsh

- Build: `npm run build` (esbuild bundle + d.ts). Test: `npm test` (e2e vs fake server, ~2s). Typecheck: `npm run typecheck`.
- Real-API check on the VM: `with-secrets deepseek -- node dist/cli.js --json "..."` (set `DEEPCODE_TELEMETRY_ENABLED=false`).
- `vendor/deepcode-core` is upstream code: do not edit in place. Changes go in `vendor/patches/*.patch` and are applied by `scripts/sync-upstream.sh`.
- The core finds templates at `<dir of its chunk>/..`: the bundle must keep core code in `dist/chunks/` and templates in `dist/templates`, `dist/bundled`.
- Public types live in `src/types.ts` with no imports from the core.
