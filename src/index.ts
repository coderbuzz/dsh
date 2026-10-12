import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  SessionManager,
  computeToolCallPermissions,
  createOpenAIClient,
  createOpenAIClientFactory,
  defaultsToThinkingMode,
  DEEPSEEK_V4_MODELS,
  getDefaultAutoCompactWindow,
  getDefaultContextWindow,
  getSnippet,
  getTools,
  resolveCurrentSettings,
  supportsMultimodal,
  type CreateOpenAIClient,
  type ModelUsage,
  type SessionEntry,
  type SessionMessage,
} from "../vendor/deepcode-core/src/index";
import type {
  DshEvent,
  HarnessOptions,
  Mode,
  ModelCapability,
  Permissions,
  ReasoningEffort,
  RunOptions,
  RunResult,
  RunStatus,
  ToolExecution,
  Usage,
} from "./types.js";

export type * from "./types.js";

/** Non-interactive default: an orchestrator has no TTY to answer permission prompts. */
export const ALLOW_ALL_PERMISSIONS: Permissions = {
  allow: [
    "read-in-cwd", "read-in-tmp", "read-out-cwd",
    "write-in-cwd", "write-in-tmp", "write-out-cwd",
    "delete-in-cwd", "delete-out-cwd",
    "query-git-log", "mutate-git-log",
    "network", "mcp",
  ],
  deny: [],
  ask: [],
  defaultMode: "allowAll",
  addWorkingDirs: [],
};

const READ_SCOPES = ["read-in-cwd", "read-in-tmp", "read-out-cwd", "query-git-log", "network", "mcp"] as const;
// defaultMode stays allowAll: bash calls with "unknown" scopes would otherwise stop the run to ask.
export const MODE_PERMISSIONS: Record<Mode, Permissions> = {
  plan: {
    allow: [...READ_SCOPES],
    deny: ["write-in-cwd", "write-in-tmp", "write-out-cwd", "delete-in-cwd", "delete-out-cwd", "mutate-git-log"],
    ask: [],
    defaultMode: "allowAll",
    addWorkingDirs: [],
  },
  edit: {
    allow: [...READ_SCOPES, "write-in-cwd", "write-in-tmp", "delete-in-cwd"],
    deny: ["write-out-cwd", "delete-out-cwd", "mutate-git-log"],
    ask: [],
    defaultMode: "allowAll",
    addWorkingDirs: [],
  },
  yolo: ALLOW_ALL_PERMISSIONS,
};

// Classifying side effects = asking "what would need approval if nothing were allowed".
const CLASSIFY_ONLY: Permissions = { allow: [], deny: [], ask: [], defaultMode: "askAll", addWorkingDirs: [] };

type Overrides = Pick<RunOptions, "model" | "thinkingEnabled" | "reasoningEffort" | "temperature">;

export type Harness = {
  run(prompt: string, options?: RunOptions): Promise<RunResult>;
  dispose(): void;
};

/**
 * One SessionManager (and its MCP servers) reused across runs. Runs on one harness must not overlap.
 * The OpenAI client and its undici keep-alive agent (180s) are module-level in the core, so TCP/TLS
 * stays warm across runs and harnesses in the same process.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const permissions = options.permissions ?? MODE_PERMISSIONS[options.mode ?? "yolo"];
  // Case-insensitive, so zh-style names ("Bash", "WebSearch") work too.
  const toolNames = getTools({}).map((t) => t.function.name);
  const disallowedTools = options.disallowedTools?.length
    ? options.disallowedTools.map((n) => toolNames.find((t) => t.toLowerCase() === n.toLowerCase()) ?? n)
    : undefined;
  let overrides: Overrides = {};
  let listener: { onMessage(m: SessionMessage): void; onEntry(e: SessionEntry): void; onStdout(pid: number, chunk: string): void } | null =
    null;

  const base = createOpenAIClientFactory(cwd);
  const factory: CreateOpenAIClient = Object.assign(
    // Telemetry (a ping per prompt to the upstream vendor) is off unless explicitly enabled.
    () => ({ ...base(), telemetryEnabled: process.env["DEEPCODE_TELEMETRY_ENABLED"] === "true", ...defined(overrides) }),
    { prepare: base.prepare }
  );

  const manager = new SessionManager({
    projectRoot: cwd,
    createOpenAIClient: factory,
    getResolvedSettings: () => {
      const settings = resolveCurrentSettings(cwd);
      return { ...settings, model: overrides.model ?? settings.model, permissions, disallowedTools };
    },
    renderMarkdown: (text) => text,
    nonInteractive: true,
    onAssistantMessage: (message, persisted) => persisted && listener?.onMessage(message),
    onSessionEntryUpdated: (entry) => listener?.onEntry(entry),
    onProcessStdout: (pid, chunk) => listener?.onStdout(pid, chunk),
  });
  await manager.initMcpServers(resolveCurrentSettings(cwd).mcpServers);

  async function run(prompt: string, opts: RunOptions = {}): Promise<RunResult> {
    if (opts.temperature !== undefined && !(opts.temperature >= 0 && opts.temperature <= 2)) {
      throw new RangeError("temperature must be between 0 and 2");
    }
    overrides = {
      model: opts.model,
      thinkingEnabled: opts.thinkingEnabled,
      reasoningEffort: opts.reasoningEffort,
      temperature: opts.temperature,
    };
    const emit = (event: DshEvent) => opts.onEvent?.(event);
    const model = factory().model;
    let sessionId: string | null = opts.sessionId ?? null;
    const usageBefore = sessionId ? (manager.getSession(sessionId)?.usage ?? null) : null;
    const thinking: string[] = [];
    const tools = new Map<string, ToolExecution>();
    const running: string[] = []; // tool calls of the current batch without a result yet (tools run sequentially)

    listener = {
      onEntry(entry) {
        if (sessionId === null) {
          sessionId = entry.id;
          emit({ type: "session", sessionId });
        }
      },
      onMessage(message) {
        const params = (message.messageParams ?? {}) as {
          reasoning_content?: string;
          tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          tool_call_id?: string;
        };
        if (message.role === "assistant") {
          if (params.reasoning_content) {
            thinking.push(params.reasoning_content);
            emit({ type: "thinking", text: params.reasoning_content });
          }
          if (message.content) emit({ type: "assistant", text: message.content });
          const calls = params.tool_calls ?? [];
          const scopes = sideEffects(message.sessionId, cwd, calls);
          for (const call of calls) {
            const exec: ToolExecution = {
              id: call.id,
              name: call.function.name,
              arguments: parseJson(call.function.arguments),
              sideEffects: scopes.get(call.id) ?? [],
              process_stdout: "",
              result: null,
            };
            tools.set(call.id, exec);
            running.push(call.id);
            emit({ type: "tool_call", id: exec.id, name: exec.name, arguments: exec.arguments, sideEffects: exec.sideEffects });
          }
        } else if (message.role === "tool" && params.tool_call_id) {
          const exec = tools.get(params.tool_call_id);
          const payload = parseJson(message.content ?? "") as Record<string, unknown> | string;
          const result =
            payload && typeof payload === "object"
              ? {
                  ok: payload["ok"] === true,
                  output: payload["output"] as string | undefined,
                  error: payload["error"] as string | undefined,
                  metadata: payload["metadata"] as Record<string, unknown> | undefined,
                }
              : { ok: false, output: String(payload) };
          if (exec) exec.result = result;
          running.splice(running.indexOf(params.tool_call_id) >>> 0, 1);
          emit({ type: "tool_result", id: params.tool_call_id, name: exec?.name ?? "", ...result });
        }
      },
      onStdout(pid, raw) {
        // ponytail: assumes the core's cwd marker line arrives in one chunk; it is a single printf at the end.
        const chunk = raw.replace(/__DEEPCODE_PWD__\w+__[^\n]*\n?/g, "");
        if (!chunk) return;
        const id = running[0] ?? null;
        const exec = id ? tools.get(id) : undefined;
        if (exec) exec.process_stdout += chunk;
        emit({ type: "process_stdout", id, pid, chunk });
      },
    };

    const controller = new AbortController();
    // interruptSession also kills the session's child processes; a bare abort would leave them running.
    const abort = () => (sessionId && manager.getSession(sessionId) ? manager.interruptSession(sessionId) : controller.abort());
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          abort();
        }, opts.timeoutMs)
      : undefined;

    let error: string | null = null;
    try {
      if (sessionId) {
        if (!manager.getSession(sessionId)) {
          error = `No saved session found with ID "${sessionId}" in ${cwd}`;
        } else {
          await manager.replySession(sessionId, { text: prompt }, controller);
        }
      } else {
        sessionId = await manager.createSession({ text: prompt }, controller);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      opts.signal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      listener = null;
    }

    const entry = sessionId ? manager.getSession(sessionId) : null;
    if (timedOut) error = `timeout after ${opts.timeoutMs}ms`;
    const status: RunStatus = timedOut || error ? "failed" : controller.signal.aborted ? "interrupted" : mapStatus(entry?.status);
    const result: RunResult = {
      sessionId,
      status,
      reply: entry?.assistantReply ?? "",
      thinking: thinking.join("\n\n"),
      toolExecutions: [...tools.values()],
      usage: toUsage(diffUsage(entry?.usage ?? null, usageBefore)),
      model,
      failReason: status === "completed" ? null : (error ?? describeFailure(entry)),
    };
    emit({ type: "result", ...result });
    return result;
  }

  return { run, dispose: () => manager.dispose() };
}

/** One-shot: create a harness, run one prompt (or continue `sessionId`), dispose. */
export async function run(prompt: string, options: RunOptions & HarnessOptions = {}): Promise<RunResult> {
  const harness = await createHarness(options);
  try {
    return await harness.run(prompt, options);
  } finally {
    harness.dispose();
  }
}

function mapStatus(status: SessionEntry["status"] | undefined): RunStatus {
  switch (status) {
    case "completed":
    case "interrupted":
    case "waiting_for_user":
      return status;
    case "ask_permission":
      return "waiting_for_user";
    default:
      return "failed";
  }
}

function describeFailure(entry: SessionEntry | null | undefined): string {
  if (!entry) return "Execution failed before a session was created.";
  if (entry.status === "ask_permission") {
    const asks = (entry.askPermissions ?? []).map((a) => `${a.name} [${a.scopes.join(", ")}]`).join("; ");
    return `Permission confirmation required: ${asks || "unknown"}. Add the scopes to permissions.allow.`;
  }
  if (entry.status === "waiting_for_user") return "The agent asked the user a question (AskUserQuestion). Reply with sessionId.";
  return entry.failReason ?? `Execution ended with status "${entry.status}".`;
}

function sideEffects(sessionId: string, projectRoot: string, toolCalls: unknown[]): Map<string, string[]> {
  if (toolCalls.length === 0) return new Map();
  const plan = computeToolCallPermissions({
    sessionId,
    projectRoot,
    toolCalls,
    settings: CLASSIFY_ONLY,
    resolveSnippetPath: (id, snippetId) => getSnippet(id, snippetId)?.filePath,
  });
  return new Map(plan.askPermissions.map((a) => [a.toolCallId, a.scopes as string[]]));
}

function diffUsage(after: unknown, before: unknown): unknown {
  if (typeof after === "number") return after - (typeof before === "number" ? before : 0);
  if (after && typeof after === "object") {
    const b = (before && typeof before === "object" ? before : {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(after).map(([k, v]) => [k, diffUsage(v, b[k])]));
  }
  return after;
}

function toUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as Partial<ModelUsage>;
  const details = (u.completion_tokens_details ?? {}) as { reasoning_tokens?: number };
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    total_tokens: u.total_tokens ?? 0,
    prompt_cache_hit_tokens: u.prompt_cache_hit_tokens ?? 0,
    prompt_cache_miss_tokens: u.prompt_cache_miss_tokens ?? 0,
    reasoning_tokens: details.reasoning_tokens ?? 0,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function defined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

const KNOWN_MODELS = [...DEEPSEEK_V4_MODELS, "deepseek-chat", "deepseek-reasoner"];
const DISPLAY_NAMES: Record<string, string> = { "deepseek-flash": "DeepSeek-V4.1-Flash" };
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cachePath(): string {
  return path.join(os.homedir(), ".deepcode", "dsh-models.json");
}

export function describeModel(id: string): ModelCapability {
  const effortLevels = DEEPSEEK_V4_MODELS.has(id);
  const thinking = defaultsToThinkingMode(id) || id === "deepseek-reasoner";
  return {
    id,
    name: DISPLAY_NAMES[id] ?? id,
    contextWindow: getDefaultContextWindow(id),
    autoCompactWindow: getDefaultAutoCompactWindow(id),
    modalities: supportsMultimodal(id) ? ["text", "image"] : ["text"],
    thinking: {
      supported: thinking,
      levels: effortLevels ? (["low", "high", "max"] satisfies ReasoningEffort[]) : [],
      // The core sends "max" unless settings say otherwise.
      default: effortLevels ? "max" : null,
    },
    supportsTools: id !== "deepseek-reasoner",
    supportsCache: true,
  };
}

/**
 * GET /models from the configured provider, enriched with harness capabilities.
 * Falls back to the cached list (24h), then to the built-in list when there is no API key or the call fails.
 */
export async function getAvailableModels(options: { refresh?: boolean; cwd?: string } = {}): Promise<ModelCapability[]> {
  const file = cachePath();
  if (!options.refresh) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8")) as { at: number; ids: string[] };
      if (Date.now() - cached.at < CACHE_TTL_MS) return cached.ids.map(describeModel);
    } catch {
      // no cache yet
    }
  }
  const { client } = createOpenAIClient(path.resolve(options.cwd ?? process.cwd()));
  if (client) {
    try {
      const ids: string[] = [];
      for await (const model of client.models.list({ signal: AbortSignal.timeout(10_000) })) ids.push(model.id);
      if (ids.length) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, JSON.stringify({ at: Date.now(), ids }));
        } catch {
          // cache is best effort
        }
        return ids.map(describeModel);
      }
    } catch {
      // offline or rejected: fall through
    }
  }
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { ids: string[] }).ids.map(describeModel);
  } catch {
    return KNOWN_MODELS.map(describeModel);
  }
}
