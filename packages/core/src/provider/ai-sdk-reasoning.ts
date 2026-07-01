import type { AiSdkProvider } from "@aio-proxy/types";
import type { TextStreamPart, ToolSet } from "../ai-sdk-bridge";

type ReasoningContentShape = {
  readonly reasoning_content?: unknown;
};

type ReasoningDeltaPart = Extract<
  TextStreamPart<ToolSet>,
  { readonly type: "reasoning-delta" }
>;

export type AiSdkReasoningAdapter = {
  readonly push: (
    part: TextStreamPart<ToolSet>,
  ) => readonly TextStreamPart<ToolSet>[];
  readonly flush: () => readonly TextStreamPart<ToolSet>[];
};

export function createAiSdkReasoningAdapter(
  config: AiSdkProvider,
  modelId: string,
): AiSdkReasoningAdapter {
  if (!parsesDeepSeekReasoning(config, modelId)) {
    return {
      push(part) {
        return [part];
      },
      flush() {
        return [];
      },
    };
  }

  let pendingReasoning = "";
  let pendingNative: ReasoningDeltaPart[] = [];
  const nativeReasoning = new Set<string>();

  function takeNative(): readonly TextStreamPart<ToolSet>[] {
    const native = pendingNative;
    pendingNative = [];
    return native;
  }

  function flushRaw(): readonly TextStreamPart<ToolSet>[] {
    if (pendingReasoning === "") {
      return [];
    }

    const text = pendingReasoning;
    pendingReasoning = "";
    return [{ type: "reasoning-delta", id: "reasoning-aio-proxy", text }];
  }

  function flush(): readonly TextStreamPart<ToolSet>[] {
    return [...flushRaw(), ...takeNative()];
  }

  return {
    push(part) {
      switch (part.type) {
        case "raw": {
          const reasoning = reasoningContent(part.rawValue);
          if (reasoning === undefined || nativeReasoning.has(reasoning)) {
            return [part];
          }
          pendingReasoning += reasoning;
          return [part];
        }
        case "reasoning-start":
          return [part];
        case "reasoning-end":
          return [...flush(), part];
        case "reasoning-delta": {
          nativeReasoning.add(part.text);
          if (pendingReasoning === "") {
            return [part];
          }

          pendingNative = [...pendingNative, part];
          const nativeText = pendingNative.map((item) => item.text).join("");

          if (
            pendingReasoning === nativeText ||
            nativeText.startsWith(pendingReasoning)
          ) {
            pendingReasoning = "";
            return takeNative();
          }

          if (pendingReasoning.startsWith(nativeText)) {
            return [];
          }

          return flush();
        }
        default:
          return [...flush(), part];
      }
    },
    flush,
  };
}

export function parsesDeepSeekReasoning(
  config: AiSdkProvider,
  modelId: string,
): boolean {
  return (
    config.packageName === "@ai-sdk/openai-compatible" &&
    (config.parseReasoningContent === true ||
      modelId === "deepseek-reasoner" ||
      modelId.startsWith("deepseek-r1"))
  );
}

function reasoningContent(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = reasoningContent(item);
      if (nested !== undefined) {
        return nested;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const candidate: ReasoningContentShape = value;
  const direct = candidate.reasoning_content;
  if (typeof direct === "string" && direct !== "") {
    return direct;
  }

  for (const nested of Object.values(value)) {
    const found = reasoningContent(nested);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
