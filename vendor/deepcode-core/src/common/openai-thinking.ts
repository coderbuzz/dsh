import type { ReasoningEffort } from "../settings";

type ThinkingConfig = {
  type: "enabled" | "disabled";
};

type ThinkingRequestOptions = {
  thinking?: ThinkingConfig;
  // dsh patch: top level, not `extra_body`. The Node OpenAI SDK sends `extra_body` as a literal
  // JSON key, which the DeepSeek API ignores (verified 2026-10-12: a bogus top-level value is
  // rejected with 422, a bogus `extra_body.reasoning_effort` is accepted with 200).
  reasoning_effort?: ReasoningEffort;
};

export function buildThinkingRequestOptions(
  thinkingEnabled: boolean,
  _baseURL?: string,
  reasoningEffort: ReasoningEffort = "max"
): ThinkingRequestOptions {
  const thinking: ThinkingConfig = { type: thinkingEnabled ? "enabled" : "disabled" };

  return {
    thinking,
    ...(thinkingEnabled ? { reasoning_effort: reasoningEffort } : {}),
  };
}
