import type { JSONObject } from "@ai-sdk/provider";

import { z } from "zod";

import type { JSONValue } from "../ai-sdk-bridge";
import type { OpenAIResponsesExecutableTool, OpenAIResponsesTool } from "../ingress/openai-responses";
import type { OpenAIResponsesTransformTool, OpenAIResponsesWireMetadata } from "./openai-responses-types";

import { OpenAIResponsesTransformError, OpenAIResponsesUnsupportedFeatureError } from "../error";

const jsonValueSchema = z.json();

export function normalizeOpenAIResponsesTools(
  sources: readonly {
    readonly tools: readonly OpenAIResponsesTool[] | undefined;
    readonly source: "request" | "additional_tools";
    readonly inputIndex?: number;
  }[],
): OpenAIResponsesTransformTool[] | undefined {
  const result: OpenAIResponsesTransformTool[] = [];
  const names = new Set<string>();
  const add = (tool: OpenAIResponsesTransformTool, path: string) => {
    if (names.has(tool.name)) throw new OpenAIResponsesTransformError(path);
    names.add(tool.name);
    result.push(tool);
  };

  for (const source of sources) {
    for (const [toolIndex, tool] of (source.tools ?? []).entries()) {
      const path = source.source === "request" ? `tools.${toolIndex}` : `input.${source.inputIndex}.tools.${toolIndex}`;
      if (tool.type === "__aio_proxy_unsupported_tool__") rejectOpenAIResponsesFeature(tool.wireType, `${path}.type`);
      if (tool.type === "namespace") {
        for (const [childIndex, child] of tool.tools.entries()) {
          add(normalizeTool(child, source, `${path}.tools.${childIndex}`, tool), `${path}.tools.${childIndex}.name`);
        }
      } else {
        add(normalizeTool(tool, source, path), `${path}.name`);
      }
    }
  }

  return result.length === 0 ? undefined : result;
}

export function flattenOpenAIResponsesToolName(namespace: string | undefined, name: string): string {
  return namespace === undefined ? name : `${namespace}__${name}`;
}

export function wireToolMetadata(metadata: OpenAIResponsesWireMetadata): JSONObject {
  return wireProviderOptions(metadata) as unknown as JSONObject;
}

export function wireProviderOptions(metadata: OpenAIResponsesWireMetadata) {
  return { aioProxy: { openaiResponses: metadata as unknown as Record<string, JSONValue> } };
}

export function readOpenAIResponsesWireMetadata(value: unknown): OpenAIResponsesWireMetadata | undefined {
  if (typeof value !== "object" || value === null || !("aioProxy" in value)) return undefined;
  const aioProxy = value.aioProxy;
  if (typeof aioProxy !== "object" || aioProxy === null || !("openaiResponses" in aioProxy)) return undefined;
  const metadata = aioProxy.openaiResponses;
  if (typeof metadata !== "object" || metadata === null || !("protocol" in metadata)) return undefined;
  return metadata.protocol === "openai-responses" ? (metadata as unknown as OpenAIResponsesWireMetadata) : undefined;
}

export function warnOpenAIResponsesDegradation(feature: string, path: string, action: string): void {
  console.warn("[aio-proxy] OpenAI Responses model conversion degraded", feature, path, action);
}

export function rejectOpenAIResponsesFeature(feature: string, path: string): never {
  warnOpenAIResponsesDegradation(feature, path, "rejected");
  throw new OpenAIResponsesUnsupportedFeatureError(feature, path);
}

function normalizeTool(
  tool: Exclude<OpenAIResponsesExecutableTool, { type: "namespace" }>,
  source: { readonly source: "request" | "additional_tools"; readonly inputIndex?: number },
  path: string,
  namespace?: Extract<OpenAIResponsesExecutableTool, { type: "namespace" }>,
): OpenAIResponsesTransformTool {
  if (tool.type === "function" && tool.defer_loading === true) {
    rejectOpenAIResponsesFeature("defer_loading", `${path}.defer_loading`);
  }
  const metadata: OpenAIResponsesWireMetadata = {
    protocol: "openai-responses",
    ...(source.inputIndex === undefined ? {} : { inputIndex: source.inputIndex }),
    wireToolType: tool.type,
    wireToolName: tool.name,
    ...(namespace === undefined ? {} : { namespace: namespace.name }),
    ...(namespace?.description === undefined ? {} : { namespaceDescription: namespace.description }),
    source: source.source,
    ...(tool.type === "custom" && tool.format !== undefined ? { format: jsonValue(tool.format) } : {}),
  };
  return {
    type: "function",
    name: flattenOpenAIResponsesToolName(namespace?.name, tool.name),
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(tool.type === "function"
      ? {
          ...(tool.parameters === undefined ? {} : { inputSchema: tool.parameters }),
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        }
      : {
          inputSchema: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        }),
    metadata: wireToolMetadata(metadata),
  };
}

function jsonValue(value: unknown): JSONValue {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
