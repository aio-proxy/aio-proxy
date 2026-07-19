import type { JsonValue, ProviderExecutedTool } from "@aio-proxy/plugin-sdk";

export class AntigravityWebSearchError extends TypeError {
  override readonly name = "AntigravityWebSearchError";
}

export function ccaGoogleSearch(tool: ProviderExecutedTool, metadata: JsonValue | undefined) {
  if (!supportsWebSearch(metadata)) {
    throw new AntigravityWebSearchError("The selected Antigravity model does not support web search");
  }
  const allowedDomains = nonEmpty(tool.allowedDomains);
  return {
    googleSearch: {
      enhancedContent: { imageSearch: { maxResultCount: tool.maxUses ?? 5 } },
      ...(allowedDomains === undefined ? {} : { includedDomains: allowedDomains }),
    },
  };
}

export function ccaWebSearchInstruction(tools: readonly ProviderExecutedTool[]): string {
  const blockedDomains = [...new Set(tools.flatMap((tool) => nonEmpty(tool.blockedDomains) ?? []))];
  const instruction = "Use Google Search when current or external information would improve the answer.";
  return blockedDomains.length === 0
    ? instruction
    : `${instruction}\nExclude results from: ${blockedDomains.join(", ")}`;
}

function supportsWebSearch(metadata: JsonValue | undefined): boolean {
  const root = record(metadata);
  const antigravity = record(Reflect.get(root ?? {}, "antigravity"));
  return Reflect.get(antigravity ?? {}, "supportsWebSearch") === true;
}

function nonEmpty(values: readonly string[] | undefined): readonly string[] | undefined {
  return values === undefined || values.length === 0 ? undefined : values;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
