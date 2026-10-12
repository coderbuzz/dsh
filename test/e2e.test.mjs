// End-to-end: built CLI against a fake DeepSeek server (no API key needed).
// Turn 1: model calls bash, then answers. Turn 2 resumes the session; its request must start
// with turn 1's exact messages (stable prefix = DeepSeek prefix cache hits).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const requests = [];
const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36, completion_tokens_details: { reasoning_tokens: 5 } };

function sse(res, delta, withUsage) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (d, extra = {}) => `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: d ? [{ index: 0, delta: d, finish_reason: null }] : [], ...extra })}\n\n`;
  const done = { id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] };
  res.end(chunk(delta) + `data: ${JSON.stringify(done)}\n\n` + (withUsage ? chunk(null, { usage }) : "") + "data: [DONE]\n\n");
}

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-pro", object: "model" }] }));
  }
  const json = JSON.parse(body);
  if (!json.tools) return sse(res, { role: "assistant", content: "[]" }, false); // skill matching
  requests.push(json);
  const last = json.messages.at(-1);
  if (last.role === "tool") return sse(res, { role: "assistant", reasoning_content: "thought-2", content: "done" }, true);
  if (last.role === "user" && JSON.stringify(last.content).includes("again")) return sse(res, { role: "assistant", reasoning_content: "thought-3", content: "again-done" }, true);
  const user = JSON.stringify(json.messages.filter((m) => m.role === "user").at(-1)?.content);
  if (user.includes("PARALLEL")) return sse(res, { role: "assistant", content: "parallel-done" }, true);
  const command = user.includes("SLEEP")
    ? "sleep 37.25"
    : user.includes("ENVCHECK")
      ? "env | grep -E '^(DEEPCODE_)?(PLUS_)?API_KEY=' | wc -l; echo MARK=$MARK USERVAR=${OTHER_API_KEY:-unset}"
      : "echo hello-dsh";
  sse(res, {
    role: "assistant",
    reasoning_content: "thought-1",
    tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }],
  }, true);
});

const run = promisify(execFile);
const cli = path.resolve("dist/cli.js");

let cwd, env;
test.before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-proj-"));
  env = {
    ...process.env,
    HOME: fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-")),
    DEEPCODE_API_KEY: "test",
    DEEPCODE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  };
});
test.after(() => server.close());

test("cli --json, then --stream-json resume", async () => {

  const first = await run("node", [cli, "--json", "-m", "deepseek-v4-pro", "-e", "high", "-t", "0.3", "say hi"], { cwd, env });
  const r1 = JSON.parse(first.stdout);
  assert.equal(r1.status, "completed", r1.failReason);
  assert.equal(r1.reply, "done");
  assert.equal(r1.model, "deepseek-v4-pro");
  assert.equal(r1.thinking, "thought-1\n\nthought-2");
  assert.equal(r1.toolExecutions.length, 1);
  const [bash] = r1.toolExecutions;
  assert.equal(bash.name, "bash");
  assert.deepEqual(bash.arguments, { command: "echo hello-dsh" });
  assert.ok(Array.isArray(bash.sideEffects));
  assert.equal(bash.process_stdout, "hello-dsh\n");
  assert.equal(bash.result.ok, true);
  assert.equal(bash.result.metadata.exitCode, 0);
  assert.deepEqual(r1.usage, { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 72, reasoning_tokens: 10 });

  const [req] = requests;
  assert.equal(req.model, "deepseek-v4-pro");
  assert.equal(req.temperature, 0.3);
  assert.deepEqual(req.thinking, { type: "enabled" });
  assert.equal(req.reasoning_effort, "high");
  assert.equal(req.extra_body, undefined);

  const second = await run("node", [cli, "--stream-json", "--no-thinking", "-m", "deepseek-v4-pro", "-r", r1.sessionId, "again"], { cwd, env });
  const events = second.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const r2 = events.at(-1);
  assert.equal(r2.type, "result");
  assert.equal(r2.status, "completed", r2.failReason);
  assert.equal(r2.sessionId, r1.sessionId);
  assert.equal(r2.reply, "again-done");
  assert.equal(r2.usage.total_tokens, 120, "usage counts this call only");
  assert.ok(events.some((e) => e.type === "assistant" && e.text === "again-done"));

  const resumed = requests.at(-1);
  assert.deepEqual(resumed.thinking, { type: "disabled" });
  const prior = requests[1].messages; // turn 1's last request
  assert.deepEqual(resumed.messages.slice(0, prior.length), prior, "resume keeps the message prefix stable");

  await assert.rejects(run("node", [cli, "--json", "-r", "00000000-0000-0000-0000-000000000000", "x"], { cwd, env }), (err) => {
    assert.equal(JSON.parse(err.stdout).status, "failed");
    return true;
  });

  const models = JSON.parse((await run("node", [cli, "models", "--json", "--refresh"], { cwd, env })).stdout);
  assert.deepEqual(models.map((m) => m.id), ["deepseek-v4-pro"]);
});

test("plan mode without bash: tool removed and refused if called anyway", async () => {
  const n = requests.length;
  const out = await run("node", [cli, "--json", "--mode", "plan", "--disallowed-tools", "Bash", "-p", "-- say hi"], { cwd, env });
  const r = JSON.parse(out.stdout);
  assert.equal(r.status, "completed", r.failReason);
  const req = requests[n];
  assert.ok(!req.tools.some((t) => t.function.name === "bash"), "bash not offered");
  assert.ok(!req.messages[0].content.includes("## Bash"), "bash docs not in system prompt");
  assert.equal(r.toolExecutions[0].result.ok, false);
  assert.match(r.toolExecutions[0].result.error, /not available/);
  assert.equal(r.toolExecutions[0].process_stdout, "", "nothing ran");
});

test("timeout stops the run and kills its child processes", async () => {
  const t0 = Date.now();
  const err = await run("node", [cli, "--json", "--timeout", "2", "SLEEP please"], { cwd, env }).catch((e) => e);
  const r = JSON.parse(err.stdout);
  assert.equal(r.status, "failed");
  assert.match(r.failReason, /timeout/);
  assert.ok(Date.now() - t0 < 15_000);
  // SIGKILL reaches the child asynchronously: poll briefly instead of asserting at the instant dsh exits.
  let left = "x";
  for (let i = 0; i < 20 && left !== ""; i++) {
    left = await run("pgrep", ["-f", "sleep 37.25"]).then((o) => o.stdout, () => "");
    if (left !== "") await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(left, "", "sleep child was killed");
});

test("parallel runs in one project keep every session resumable", async () => {
  const outs = await Promise.all([1, 2, 3, 4].map((i) => run("node", [cli, "--json", `PARALLEL ${i}`], { cwd, env })));
  const ids = outs.map((o) => JSON.parse(o.stdout).sessionId);
  for (const id of ids) {
    const r = JSON.parse((await run("node", [cli, "--json", "-r", id, "PARALLEL again"], { cwd, env }).catch((e) => e)).stdout);
    assert.equal(r.status, "completed", `session ${id}: ${r.failReason}`);
  }
});

test("telemetry is off unless DEEPCODE_TELEMETRY_ENABLED=true", async () => {
  // Preload: record every global fetch URL on stderr and answer locally (telemetry uses global fetch).
  const spy = "data:text/javascript," + encodeURIComponent(
    "const f=globalThis.fetch;globalThis.fetch=(u,o)=>{const s=String(u);if(!s.startsWith('http://127.0.0.1')){process.stderr.write('FETCH '+s+'\\n');return Promise.resolve(new Response('{}'))}return f(u,o)}"
  );
  const runWith = (extra) => run("node", ["--import", spy, cli, "--json", "PARALLEL telemetry"], { cwd, env: { ...env, ...extra } });
  const off = await runWith({});
  assert.doesNotMatch(off.stderr, /\/api\/plugin\/new/);
  const on = await runWith({ DEEPCODE_TELEMETRY_ENABLED: "true" });
  assert.match(on.stderr, /\/api\/plugin\/new/, "probe sees telemetry when enabled");
});

test("agent bash does not see the provider API key, but keeps other env", async () => {
  const out = await run("node", [cli, "--json", "ENVCHECK"], { cwd, env: { ...env, DEEPCODE_PLUS_API_KEY: "sk-x", MARK: "kept", OTHER_API_KEY: "mine" } });
  const r = JSON.parse(out.stdout);
  assert.equal(r.status, "completed", r.failReason);
  // 0 = none of DEEPCODE_API_KEY, DEEPCODE_PLUS_API_KEY and the prefix-stripped API_KEY/PLUS_API_KEY reach the shell;
  // the user's own variables (even ones ending in API_KEY) are untouched.
  assert.equal(r.toolExecutions[0].process_stdout, "0\nMARK=kept USERVAR=mine\n");
});
