import { parseArgs } from "node:util";
import { getAvailableModels, run } from "./index.js";
import type { Mode, ReasoningEffort } from "./types.js";

const USAGE = `Usage:
  dsh [options] [prompt...]        Run one agent turn (prompt from -p, args, else stdin)
  dsh models [--json] [--refresh]  List models and harness capabilities

Options:
  --json                 Print the final result as one JSON object
  --stream-json          Print events as NDJSON, ending with a "result" event
  -p, --prompt <text>    Prompt (safe for text starting with "-")
  -r, --resume <id>      Continue a saved session (keeps the prefix cache hot)
  -m, --model <id>       Model override (e.g. deepseek-v4-pro)
  --thinking / --no-thinking
  -e, --effort <level>   Reasoning effort: low | high | max | disabled (= --no-thinking)
  -t, --temperature <n>  0.0 - 2.0
  -C, --cwd <dir>        Project root (default: current directory)
  --mode <mode>          plan (read-only) | edit (writes in cwd/tmp) | yolo (default, everything)
  --disallowed-tools <a,b>  Remove tools, e.g. bash,WebSearch (bash scopes are self-declared: remove it for read-only)
  --timeout <seconds>    Stop the run (and its child processes) and report failed
  -h, --help

API key: DEEPCODE_API_KEY env or ~/.deepcode/settings.json (same as deepcode-cli).
Exit codes: 0 completed, 1 failed / waiting_for_user, 130 interrupted (SIGINT/SIGTERM).`;

async function main(): Promise<number> {
  // `-p <text>`: take the next argument verbatim, even when it starts with "-" (parseArgs would reject it).
  const argv = process.argv.slice(2);
  const pi = argv.findIndex((a) => a === "-p" || a === "--prompt");
  if (pi !== -1 && pi + 1 < argv.length) argv.splice(pi, 2, `--prompt=${argv[pi + 1]}`);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      prompt: { type: "string", short: "p" },
      mode: { type: "string" },
      "disallowed-tools": { type: "string" },
      timeout: { type: "string" },
      "stream-json": { type: "boolean" },
      resume: { type: "string", short: "r" },
      model: { type: "string", short: "m" },
      thinking: { type: "boolean" },
      "no-thinking": { type: "boolean" },
      effort: { type: "string", short: "e" },
      temperature: { type: "string", short: "t" },
      cwd: { type: "string", short: "C" },
      refresh: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  if (positionals[0] === "models") {
    const models = await getAvailableModels({ refresh: values.refresh, cwd: values.cwd });
    if (values.json) {
      process.stdout.write(JSON.stringify(models, null, 2) + "\n");
    } else {
      for (const m of models) {
        const effort = m.thinking.levels.length ? ` effort=${m.thinking.levels.join("|")}` : "";
        process.stdout.write(`${m.id}\tctx=${m.contextWindow}\t${m.modalities.join("+")}\tthinking=${m.thinking.supported}${effort}\n`);
      }
    }
    return 0;
  }

  if (values.effort && !["low", "high", "max", "disabled"].includes(values.effort)) throw new Error("--effort must be low, high, max or disabled");
  if (values.mode && !["plan", "edit", "yolo"].includes(values.mode)) throw new Error("--mode must be plan, edit or yolo");
  const temperature = values.temperature === undefined ? undefined : Number(values.temperature);
  const timeout = values.timeout === undefined ? undefined : Number(values.timeout);
  if (timeout !== undefined && !(timeout > 0)) throw new Error("--timeout must be a positive number of seconds");
  const prompt = values.prompt ?? (positionals.length ? positionals.join(" ") : process.stdin.isTTY ? "" : await readStdin());
  if (!prompt.trim()) {
    process.stderr.write(USAGE + "\n");
    return 1;
  }

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const effortOff = values.effort === "disabled";
  const stream = values["stream-json"];
  const result = await run(prompt, {
    cwd: values.cwd,
    mode: values.mode as Mode | undefined,
    disallowedTools: values["disallowed-tools"]?.split(",").map((t) => t.trim()).filter(Boolean),
    timeoutMs: timeout === undefined ? undefined : timeout * 1000,
    sessionId: values.resume,
    model: values.model,
    thinkingEnabled: values["no-thinking"] || effortOff ? false : values.thinking,
    reasoningEffort: effortOff ? undefined : (values.effort as ReasoningEffort | undefined),
    temperature,
    signal: controller.signal,
    onEvent: stream ? (event) => process.stdout.write(JSON.stringify(event) + "\n") : undefined,
  });

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (!stream) {
    if (result.status === "completed") process.stdout.write(result.reply + "\n");
    else process.stderr.write(`dsh: ${result.status}: ${result.failReason ?? ""}\n`);
    if (result.sessionId) process.stderr.write(`session: ${result.sessionId}\n`);
  }
  return result.status === "completed" ? 0 : result.status === "interrupted" ? 130 : 1;
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`dsh: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
);
