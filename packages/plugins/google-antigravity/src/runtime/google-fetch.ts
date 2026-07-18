import type { GoogleProviderSettings } from "@ai-sdk/google";
import type { JsonValue, LogicalRequestContext, ProviderExecutedTool } from "@aio-proxy/plugin-sdk";
import { repairGroundingSse, repairGroundingUrls } from "../protocol/grounding-urls";
import { type AntigravityThinkingOption, applyAntigravityThinking } from "../protocol/thinking";
import { AntigravityToolSchemaValidationError } from "../protocol/tool-schema";
import { ccaGoogleSearch, ccaWebSearchInstruction } from "../protocol/web-search";
import { createGeminiErrorResponse, unwrapCcaJson } from "./raw";
import { unwrapCcaSse } from "./stream";
import type { CcaTransport } from "./transport";

export type AntigravityGoogleFetchContext = {
  readonly context: LogicalRequestContext;
  readonly fetch?: typeof globalThis.fetch;
  readonly modelMetadata?: JsonValue;
  readonly providerTools?: readonly ProviderExecutedTool[];
  readonly thinking?: AntigravityThinkingOption;
  readonly transport: CcaTransport;
};

export function createAntigravityGoogleFetch(
  call: AntigravityGoogleFetchContext,
  modelId: string,
): NonNullable<GoogleProviderSettings["fetch"]> {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const target = parseGoogleTarget(request.url, modelId);
    const body = applyProviderTools(
      applyPrivateThinking(await readGoogleBody(request), modelId, call.thinking),
      call.providerTools,
      call.modelMetadata,
    );
    let response: Response;
    try {
      response = await call.transport.execute({
        body,
        context: call.context,
        modelId: target.modelId,
        requestType: "agent",
        stream: target.stream,
        signal: request.signal,
      });
    } catch (error) {
      if (error instanceof AntigravityToolSchemaValidationError) return createGoogleCodecErrorResponse(400);
      throw error;
    }

    if (response.body === null) return createGeminiErrorResponse(500);
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      return createGoogleCodecErrorResponse(status);
    }
    if (target.stream) {
      const headers = new Headers(response.headers);
      headers.set("Content-Type", "text/event-stream; charset=utf-8");
      const stream = unwrapCcaSse(response.body, { signal: request.signal, terminateOnError: true });
      return new Response(repairGroundingSse(stream, repairDependencies(call, request.signal)), {
        headers,
        status: response.status,
        statusText: response.statusText,
      });
    }

    let payload: unknown;
    try {
      payload = await repairGroundingUrls(
        unwrapCcaJson(await response.json()),
        repairDependencies(call, request.signal),
      );
    } catch (error) {
      throwIfAborted(request.signal);
      throw error;
    }
    const headers = new Headers(response.headers);
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify(payload), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
  return Object.assign(fetcher, { preconnect: globalThis.fetch.preconnect });
}

function applyProviderTools(
  body: Record<string, unknown>,
  providerTools: readonly ProviderExecutedTool[] | undefined,
  modelMetadata: JsonValue | undefined,
): Record<string, unknown> {
  if (providerTools === undefined || providerTools.length === 0) return body;
  const currentTools = Reflect.get(body, "tools");
  if (currentTools !== undefined && !Array.isArray(currentTools)) {
    throw new TypeError("Gemini tools must be an array");
  }
  const instruction = ccaWebSearchInstruction(providerTools);
  const systemInstruction = record(Reflect.get(body, "systemInstruction"));
  const parts = Reflect.get(systemInstruction, "parts");
  const currentParts = Array.isArray(parts) ? parts : [];
  return {
    ...body,
    tools: [...(currentTools ?? []), ...providerTools.map((tool) => ccaGoogleSearch(tool, modelMetadata))],
    systemInstruction: {
      ...systemInstruction,
      parts: [...currentParts, { text: instruction }],
    },
  };
}

function repairDependencies(call: AntigravityGoogleFetchContext, signal: AbortSignal) {
  return {
    signal,
    ...(call.fetch === undefined ? {} : { fetch: call.fetch }),
  };
}

function applyPrivateThinking(
  body: Record<string, unknown>,
  modelId: string,
  thinking: AntigravityThinkingOption | undefined,
): Record<string, unknown> {
  if (thinking === undefined) return body;
  const generationConfig = record(Reflect.get(body, "generationConfig"));
  return {
    ...body,
    generationConfig: {
      ...generationConfig,
      thinkingConfig: applyAntigravityThinking(modelId, thinking),
    },
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseGoogleTarget(url: string, modelId: string): { readonly modelId: string; readonly stream: boolean } {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/^\/[^/]+\/(.+):(generateContent|streamGenerateContent)$/u);
  if (match === null) throw new Error("Google Antigravity received an unsupported Google codec request");
  const encodedModelId = decodeURIComponent(match[1] ?? "");
  const expectedModelId = modelId.includes("/") ? modelId : `models/${modelId}`;
  if (encodedModelId !== expectedModelId) {
    throw new Error("Google Antigravity received an unsupported Google codec request");
  }
  return { modelId, stream: match[2] === "streamGenerateContent" };
}

function createGoogleCodecErrorResponse(status: number): Response {
  if (!Number.isInteger(status) || status < 300 || status > 399 || status === 304) {
    return createGeminiErrorResponse(status);
  }
  return Response.json(
    {
      error: {
        code: status,
        message: "Google Antigravity request failed",
        status: "UNKNOWN",
      },
    },
    { status },
  );
}

async function readGoogleBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch (error) {
    throwIfAborted(request.signal);
    throw error;
  }
  throw new TypeError("Google codec request body must be a JSON object");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason: unknown = signal.reason;
  throw reason ?? new DOMException("The operation was aborted", "AbortError");
}
