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
  sse(res, {
    role: "assistant",
    reasoning_content: "thought-1",
    tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "echo hello-dsh" }) } }],
  }, true);
});

const run = promisify(execFile);
const cli = path.resolve("dist/cli.js");

test("cli --json, then --stream-json resume", async (t) => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-proj-"));
  const env = {
    ...process.env,
    HOME: home,
    DEEPCODE_API_KEY: "test",
    DEEPCODE_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    DEEPCODE_TELEMETRY_ENABLED: "false",
  };

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
