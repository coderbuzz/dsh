// Public types of the dsh SDK. Self-contained on purpose: no imports from the vendored core,
// so the published .d.ts never depends on an unpublished package.

export type ReasoningEffort = "low" | "high" | "max";

export type PermissionScope =
  | "read-in-cwd"
  | "read-in-tmp"
  | "read-out-cwd"
  | "write-in-cwd"
  | "write-in-tmp"
  | "write-out-cwd"
  | "delete-in-cwd"
  | "delete-out-cwd"
  | "query-git-log"
  | "mutate-git-log"
  | "network"
  | "mcp";

export type Permissions = {
  allow: PermissionScope[];
  deny: PermissionScope[];
  ask: PermissionScope[];
  defaultMode: "allowAll" | "askAll";
  addWorkingDirs: string[];
};

export type HarnessOptions = {
  /** Project root the agent works in. Default: process.cwd(). */
  cwd?: string;
  /**
   * Permission preset (same names as zh): "plan" read-only, "edit" writes inside cwd/tmp, "yolo" everything (default).
   * Scopes of bash commands are declared by the model, so for a hard read-only boundary also disallow "bash".
   */
  mode?: Mode;
  /** Overrides `mode`. */
  permissions?: Permissions;
  /** Tool names removed from the model's tool list and refused if called anyway (e.g. ["bash", "WebSearch"]). */
  disallowedTools?: string[];
};

export type Mode = "plan" | "edit" | "yolo";

export type RunOptions = {
  /** Continue this session (replySession) instead of creating a new one. Keeps the prefix cache hot. */
  sessionId?: string;
  model?: string;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** 0.0 - 2.0 */
  temperature?: number;
  signal?: AbortSignal;
  /** Wall-clock limit; the run is interrupted (child processes killed) and reported as failed. */
  timeoutMs?: number;
  onEvent?: (event: DshEvent) => void;
};

export type RunStatus = "completed" | "failed" | "interrupted" | "waiting_for_user";

export type ToolExecution = {
  id: string;
  name: string;
  arguments: unknown;
  /** Permission scopes the call touches (e.g. "write-in-cwd", "network"); "unknown" if unclassifiable. */
  sideEffects: string[];
  /** Live terminal output collected while the tool ran. */
  process_stdout: string;
  result: {
    ok: boolean;
    output?: string;
    error?: string;
    /** e.g. exitCode, cwd, deadlineAt for bash. */
    metadata?: Record<string, unknown>;
  } | null;
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens: number;
  prompt_cache_miss_tokens: number;
  reasoning_tokens: number;
};

export type RunResult = {
  sessionId: string | null;
  status: RunStatus;
  reply: string;
  thinking: string;
  toolExecutions: ToolExecution[];
  /** Tokens spent by this call only (not the whole session). */
  usage: Usage;
  model: string;
  failReason: string | null;
};

export type DshEvent =
  | { type: "session"; sessionId: string }
  | { type: "thinking"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown; sideEffects: string[] }
  | { type: "process_stdout"; id: string | null; pid: number; chunk: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }
  | ({ type: "result" } & RunResult);

export type ModelCapability = {
  id: string;
  name: string;
  contextWindow: number;
  autoCompactWindow: number;
  modalities: ("text" | "image")[];
  thinking: { supported: boolean; levels: ReasoningEffort[]; default: ReasoningEffort | null };
  supportsTools: boolean;
  supportsCache: boolean;
};
