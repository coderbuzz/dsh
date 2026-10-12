# dsh: DeepSeek harness for orchestrators

Structured-output wrapper around the [deepcode-cli](https://github.com/lessweb/deepcode-cli) agent engine
(prefix caching, thinking, snippet edits, permissions). `deepcode --exec` prints plain text only;
`dsh` gives orchestrators JSON, NDJSON events, and an in-process TypeScript SDK.

The engine (`@vegamo/deepcode-core`, not on npm) is vendored in `vendor/deepcode-core`; see its `UPSTREAM.md`.

## Install / build

```bash
npm install && npm run build      # Node >= 22
npm link                          # optional: puts `dsh` on PATH
```

API key: `DEEPCODE_API_KEY` env var, or `~/.deepcode/settings.json` (same config as deepcode-cli;
also `DEEPCODE_BASE_URL`, `DEEPCODE_MODEL`, ...). Sessions are stored under `~/.deepcode/`.
Upstream telemetry is on by default; set `DEEPCODE_TELEMETRY_ENABLED=false` to turn it off.

## CLI

```bash
dsh --json "fix the failing test"                        # one JSON result
dsh --stream-json -m deepseek-v4-pro -e high "..."       # NDJSON events, last line {"type":"result",...}
dsh --json -r <sessionId> "now add a changelog entry"    # continue: prefix cache stays hot
echo "prompt" | dsh --json --no-thinking -t 0.2
dsh models --json [--refresh]
```

Exit codes: `0` completed, `1` failed or waiting_for_user, `130` interrupted (SIGINT).
Permissions default to allow-all (no TTY to ask). Run it only where the agent may touch the files.

## SDK

```ts
import { run, createHarness, getAvailableModels } from "@coderbuzz/dsh";

const r = await run("summarize src/", { cwd: "/repo", model: "deepseek-v4-flash", reasoningEffort: "low" });
const next = await run("now list TODOs", { cwd: "/repo", sessionId: r.sessionId });

// Many turns in one process: reuse the session manager and MCP servers.
const h = await createHarness({ cwd: "/repo" });
const a = await h.run("step 1", { onEvent: (e) => console.log(e.type) });
const b = await h.run("step 2", { sessionId: a.sessionId });
h.dispose();
```

Runs on one harness must not overlap. `createHarness({ permissions })` overrides the allow-all default.

### Result

```jsonc
{
  "sessionId": "uuid",
  "status": "completed",            // | "failed" | "interrupted" | "waiting_for_user"
  "reply": "final assistant text",
  "thinking": "reasoning_content of every model call in this run, joined",
  "toolExecutions": [{
    "id": "call_..", "name": "bash", "arguments": { "command": "npm test" },
    "sideEffects": ["write-in-cwd"],  // permission scopes the call touches
    "process_stdout": "live terminal output",
    "result": { "ok": true, "output": "...", "metadata": { "exitCode": 0, "cwd": "...", "deadlineAt": "..." } }
  }],
  "usage": {                        // this run only, summed over its model calls
    "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
    "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0, "reasoning_tokens": 0
  },
  "model": "deepseek-v4-flash",
  "failReason": null
}
```

`--stream-json` events: `session`, `thinking`, `assistant`, `tool_call`, `process_stdout`, `tool_result`, `result`.

## Prefix cache

DeepSeek caches prompt prefixes (64-token chunks). The engine keeps the order
system prompt + tools → runtime context → project instructions → history, and `sessionId` continuation
appends to it. Measured on the real API (2026-10-12): 91-98% cache hits on continuation turns.

- Keep `model` fixed across turns of a session: tools differ per model (e.g. `deepseek-flash` adds
  `ReadImage`), so switching rewrites the system prompt. Changing `reasoningEffort` or thinking does not break the cache.
- HTTP keep-alive: the engine's undici agent keeps connections for 180s; reusing one process (SDK) keeps TCP/TLS warm.

## Reasoning effort

`low | high | max`, sent as top-level `reasoning_effort`. Upstream sends it inside `extra_body`, which the
Node OpenAI SDK passes through as a literal key and DeepSeek ignores; dsh patches this
(`vendor/patches/reasoning-effort-top-level.patch`).

## Models

`getAvailableModels({ refresh })` / `dsh models --json` call `GET /models` and add harness capabilities
(context window, auto-compact threshold, image input, effort levels). Results are cached 24h in
`~/.deepcode/dsh-models.json`; with no key or no network the cache, then a built-in list, is returned.

## Tests

`npm test` builds and runs an end-to-end test against a fake DeepSeek server (no key needed):
a tool call, a resume, overrides, usage accounting, and a stable message prefix.

## Upstream sync

`scripts/sync-upstream.sh <ref>` re-vendors `packages/core` and re-applies `vendor/patches/`.
