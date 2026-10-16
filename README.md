# dsh: DeepSeek harness for orchestrators

Structured-output wrapper around the [deepcode-cli](https://github.com/lessweb/deepcode-cli) agent engine
(prefix caching, thinking, snippet edits, permissions). `deepcode --exec` prints plain text only;
`dsh` gives orchestrators JSON, NDJSON events, and an in-process TypeScript SDK.

The engine (`@vegamo/deepcode-core`, not on npm) is vendored in `vendor/deepcode-core`; see its `UPSTREAM.md`.

## Install

Needs **Node.js >= 22** (`dsh` runs `node`, so it must be on `PATH` wherever the orchestrator spawns it).

```bash
curl -fsSL https://raw.githubusercontent.com/coderbuzz/dsh/main/install.sh | sh
dsh --version
```

The installer puts the package in its own prefix (`~/.local/share/dsh`, so a Node version switch does not remove it)
and links `dsh` into `~/.local/bin`. If that directory is not on your `PATH` it prints the line to add. It is
idempotent: running it again upgrades. Options (flags after `sh -s --`, or env vars):

| Flag | Env | Default |
|---|---|---|
| `--version <v>` | `DSH_VERSION` | `latest` (pin one for reproducible installs) |
| `--prefix <dir>` | `DSH_PREFIX` | `~/.local/share/dsh` |
| `--bin-dir <dir>` | `DSH_BIN_DIR` | `~/.local/bin` (use `/usr/local/bin` for all users, with sudo) |
| `--uninstall` | | removes the prefix and the link (only a link that points into the prefix) |
| | `DSH_REGISTRY` | `https://registry.npmjs.org` |

```bash
curl -fsSL https://raw.githubusercontent.com/coderbuzz/dsh/main/install.sh | sh -s -- --version 0.1.2 --bin-dir /usr/local/bin
```

Other ways: `npm i -g @coderbuzz/dsh` (SDK users: `npm i @coderbuzz/dsh`), or from source:
`git clone https://github.com/coderbuzz/dsh && cd dsh && npm ci && npm run build && npm link`.
Releases are published from CI with npm provenance; the installer script is a plain POSIX `sh` file you can read first.

## Configure

API key: `DEEPCODE_API_KEY` env var, or `~/.deepcode/settings.json` (same file as deepcode-cli;
also `DEEPCODE_BASE_URL`, `DEEPCODE_MODEL`, ...). Sessions are stored under `~/.deepcode/`.
Upstream telemetry (a ping per prompt) is **off** in dsh; only `DEEPCODE_TELEMETRY_ENABLED=true` turns it on.

```bash
export DEEPCODE_API_KEY=sk-...
dsh models                                  # lists models (falls back to a built-in list offline)
dsh -p "say hi in one word" --json          # first run
```

## CLI

```bash
dsh --json "fix the failing test"                        # one JSON result
dsh --stream-json -m deepseek-v4-pro -e high "..."       # NDJSON events, last line {"type":"result",...}
dsh --json -r <sessionId> "now add a changelog entry"    # continue: prefix cache stays hot
echo "prompt" | dsh --json --no-thinking -t 0.2
dsh --json -C /repo --mode plan --disallowed-tools bash --timeout 900 -p "$PROMPT"   # read-only agent
dsh models --json [--refresh]
```

Exit codes: `0` completed, `1` failed or waiting_for_user, `130` interrupted (SIGINT/SIGTERM). The result is written in full before exit, so output over 64 KiB read through a pipe stays valid JSON (fixed in 0.1.4; 0.1.2 and earlier cut it at 65,536 bytes).
`--timeout <s>` stops the run, kills its child processes and reports `failed` with `failReason: "timeout ..."`.
`-p <text>` takes the next argument verbatim, also when it starts with `-`. `-e disabled` = `--no-thinking`.

### Permissions

No TTY to ask, so nothing ever prompts. `--mode` (same names as zh) picks a preset:

| mode | allowed | denied (the model gets an error and continues) |
|---|---|---|
| `yolo` (default) | everything | nothing |
| `edit` | reads, writes/deletes inside cwd and tmp, network, MCP | writes/deletes outside cwd, git history changes |
| `plan` | reads, network, MCP | all writes and deletes, git history changes |

The agent's shell does not inherit the provider credentials (`DEEPCODE_API_KEY`, `DEEPCODE_PLUS_API_KEY`); other environment variables are passed through.

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

`low | high | max`, sent as top-level `reasoning_effort`. Upstream originally sent it inside `extra_body`, which the
Node OpenAI SDK passes through as a literal key and DeepSeek ignores; the fix was merged upstream
(lessweb/deepcode-cli#370) and ships in the vendored engine since `03c7ebb`. `--effort disabled` turns thinking off.

## Models

`getAvailableModels({ refresh })` / `dsh models --json` call `GET /models` and add harness capabilities
(context window, auto-compact threshold, image input, effort levels). Results are cached 24h in
`~/.deepcode/dsh-models.json`; with no key or no network the cache, then a built-in list, is returned.

## Tests

`npm test` builds and runs an end-to-end test against a fake DeepSeek server (no key needed):
a tool call, a resume, overrides, usage accounting, a stable message prefix, plan mode without bash,
timeout killing child processes, parallel runs in one project, telemetry staying off, the API key hidden from the agent's
shell, error paths (bad key, unknown model, failing and malformed tool calls), and `install.sh` (install, rerun, uninstall, never overwriting a foreign file) on the packed tarball.
The installer test needs network access for the dependencies (~20 s).

## Release

Bump `version` in `package.json`, merge, then push tag `vX.Y.Z`: `.github/workflows/release.yml` tests and publishes
to npm with Trusted Publishing (OIDC, provenance, no token).

## Upstream sync

`scripts/sync-upstream.sh <ref>` re-vendors `packages/core` and re-applies `vendor/patches/`.
