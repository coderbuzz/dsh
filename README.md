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
Upstream telemetry (a ping per prompt) is **off** in dsh; only `DEEPCODE_TELEMETRY_ENABLED=true` turns it on.

## CLI

```bash
dsh --json "fix the failing test"                        # one JSON result
dsh --stream-json -m deepseek-v4-pro -e high "..."       # NDJSON events, last line {"type":"result",...}
dsh --json -r <sessionId> "now add a changelog entry"    # continue: prefix cache stays hot
echo "prompt" | dsh --json --no-thinking -t 0.2
dsh --json -C /repo --mode plan --disallowed-tools bash --timeout 900 -p "$PROMPT"   # read-only agent
dsh models --json [--refresh]
```

Exit codes: `0` completed, `1` failed or waiting_for_user, `130` interrupted (SIGINT/SIGTERM).
`--timeout <s>` stops the run, kills its child processes and reports `failed` with `failReason: "timeout ..."`.
`-p <text>` takes the next argument verbatim, also when it starts with `-`. `-e disabled` = `--no-thinking`.

### Permissions

No TTY to ask, so nothing ever prompts. `--mode` (same names as zh) picks a preset:

| mode | allowed | denied (the model gets an error and continues) |
|---|---|---|
| `yolo` (default) | everything | nothing |
| `edit` | reads, writes/deletes inside cwd and tmp, network, MCP | writes/deletes outside cwd, git history changes |
| `plan` | reads, network, MCP | all writes and deletes, git history changes |

Bash commands declare their own scopes (the model fills `sideEffects`), so a mode is not a boundary for bash.
For a read-only agent also pass `--disallowed-tools bash`: the tool leaves the schema and the system prompt,
and a call to it anyway is refused. SDK: `createHarness({ mode, permissions, disallowedTools })`.

### Parallel runs

Several `dsh` processes may run in one project at once: the session index is written atomically under a lock file.
Runs on one SDK harness must not overlap (use one harness per concurrent run).

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

`run(prompt, { timeoutMs, signal })` stops a run; aborting kills its child processes.

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
(`vendor/patches/reasoning-effort-top-level.patch`). `--effort disabled` turns thinking off.

## Models

`getAvailableModels({ refresh })` / `dsh models --json` call `GET /models` and add harness capabilities
(context window, auto-compact threshold, image input, effort levels). Results are cached 24h in
`~/.deepcode/dsh-models.json`; with no key or no network the cache, then a built-in list, is returned.

## Tests

`npm test` builds and runs an end-to-end test against a fake DeepSeek server (no key needed):
a tool call, a resume, overrides, usage accounting, a stable message prefix, plan mode without bash,
timeout killing child processes, parallel runs in one project, and telemetry staying off.

## Release

Bump `version` in `package.json`, merge, then push tag `vX.Y.Z`: `.github/workflows/release.yml` tests and publishes
to npm with Trusted Publishing (OIDC, provenance, no token).

## Upstream sync

`scripts/sync-upstream.sh <ref>` re-vendors `packages/core` and re-applies `vendor/patches/`.
