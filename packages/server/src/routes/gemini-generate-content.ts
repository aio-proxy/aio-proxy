import {
  type CallSettings,
  type GeminiGenerateContentSettings,
  type GeminiGenerateContentTool,
  GeminiInlineDataTooLargeError,
  geminiGenerateContentToModelMessages,
  type JSONValue,
  jsonSchema,
  parseGeminiGenerateContent,
  RouterModelNotFoundError,
  type ToolSet,
  writeGeminiGenerateContentResponse,
  writeGeminiGenerateContentSSE,
} from "@aio-proxy/core";
import { normalizeVariantKey, ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { Hono } from "hono";
import { ZodError, z } from "zod";
import { ensureAiSdkProviderAvailable, providerNotInstalled } from "../provider-availability";
import { preflightStream, resolveCandidates, shouldTryNextResponse, toAiSdkProvider } from "../route-dispatch";
import type { ProviderRouteSource } from "../runtime";
import type { UsageCompletion } from "../usage-capture";

const routePrefix = "/v1beta/models/";
const generateSuffix = ":generateContent";
const streamSuffix = ":streamGenerateContent";
const jsonValueSchema = z.json();
type GeminiAiSdkSettings = CallSettings & {
  readonly providerOptions?: {
    readonly google: {
      readonly safetySettings: JSONValue;
    };
  };
};
const aiSdkGenerationConfigSchema = z
  .object({
    maxOutputTokens: z.number().int().positive().optional(),
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().int().positive().optional(),
    stopSequences: z.array(z.string()).optional(),
    seed: z.number().int().optional(),
  })
  .strip();
const reasoningSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function createGeminiGenerateContentRoutes(source: ProviderRouteSource) {
  return new Hono().post("/v1beta/models/*", async (context) => {
    const target = routeTarget(new URL(context.req.url).pathname);
    if (target === undefined) {
      return context.text("404 Not Found", 404);
    }

    const request = await parseRequest(context.req.raw, target.model);
    if (request instanceof Response) {
      return request;
    }

    const variantKey = request.generationConfig?.thinkingConfig?.thinkingLevel;
    const candidates = resolveCandidates(source, target.model, variantKey);
    if (candidates instanceof RouterModelNotFoundError) {
      return geminiError(404, "NOT_FOUND", candidates.message);
    }

    const transformed = geminiGenerateContentToModelMessages(request);
    const tools = aiSdkTools(transformed.tools);
    const requestSession = source.requestRecorder.begin({
      inboundProtocol: ProviderProtocol.Gemini,
      requestedModelId: target.model,
    });
    let last = geminiError(501, "UNIMPLEMENTED", "Provider does not support Gemini generateContent transform dispatch");
    for (const [index, route] of candidates.entries()) {
      const attemptStartedAt = performance.now();
      const hasNext = index < candidates.length - 1;
      const provider = route.provider;
      try {
        if (provider.kind === ProviderKind.Api && provider.protocol === ProviderProtocol.Gemini) {
          const upstreamRequest =
            target.model === route.modelId
              ? context.req.raw.clone()
              : rewriteGeminiRequestModel(context.req.raw, route.modelId, target.stream);
          const response = await provider.passthrough(upstreamRequest);
          if (hasNext && shouldTryNextResponse(response)) {
            requestSession.attempt({
              providerId: provider.id,
              modelId: route.modelId,
              providerKind: provider.kind,
              protocol: provider.protocol,
              outcome: "failure",
              statusCode: response.status,
              durationMs: durationMs(attemptStartedAt),
            });
            last = response;
            continue;
          }
          if (response.status < 200 || response.status >= 400) {
            requestSession.finish({
              outcome: "failure",
              finalProviderId: provider.id,
              finalModelId: route.modelId,
              finalStatusCode: response.status,
              attempt: {
                providerId: provider.id,
                modelId: route.modelId,
                providerKind: provider.kind,
                protocol: provider.protocol,
                outcome: "failure",
                statusCode: response.status,
                durationMs: durationMs(attemptStartedAt),
              },
            });
            return response;
          }
          const captured = source.usageCapture.passthrough({
            response,
            protocol: provider.protocol,
            providerId: provider.id,
            modelId: route.modelId,
          });
          requestSession.finishFrom(
            {
              providerId: provider.id,
              modelId: route.modelId,
              providerKind: provider.kind,
              protocol: provider.protocol,
              durationMs: durationMs(attemptStartedAt),
            },
            terminalCompletion(captured.completion, context.req.raw.signal),
          );
          return captured.value;
        }

        const aiSdkProvider = toAiSdkProvider(provider);
        if (aiSdkProvider === undefined) {
          last = geminiError(
            501,
            "UNIMPLEMENTED",
            "Provider does not support Gemini generateContent transform dispatch",
          );
          const attempt = {
            providerId: provider.id,
            modelId: route.modelId,
            providerKind: provider.kind,
            ...(provider.kind === ProviderKind.Api ? { protocol: provider.protocol } : {}),
            outcome: "failure" as const,
            statusCode: last.status,
            durationMs: durationMs(attemptStartedAt),
          };
          if (hasNext) {
            requestSession.attempt(attempt);
            continue;
          }
          requestSession.finish({
            outcome: "failure",
            finalProviderId: provider.id,
            finalModelId: route.modelId,
            finalStatusCode: last.status,
            attempt,
          });
          continue;
        }

        await ensureAiSdkProviderAvailable(aiSdkProvider);
        const captured = source.usageCapture.stream({
          providerId: provider.id,
          modelId: route.modelId,
          stream: aiSdkProvider.invoke({
            messages: transformed.messages,
            modelId: route.modelId,
            settings: aiSdkSettings(transformed.settings),
            signal: context.req.raw.signal,
            ...(tools === undefined ? {} : { tools }),
          }),
        });
        if (target.stream) {
          const stream = await preflightStream(captured.value);
          requestSession.finishFrom(
            {
              providerId: provider.id,
              modelId: route.modelId,
              providerKind: provider.kind,
              durationMs: durationMs(attemptStartedAt),
            },
            terminalCompletion(captured.completion, context.req.raw.signal),
          );
          return new Response(writeGeminiGenerateContentSSE(stream), {
            headers: {
              "cache-control": "no-cache",
              "content-type": "text/event-stream; charset=utf-8",
            },
          });
        }

        const value = await writeGeminiGenerateContentResponse(captured.value);
        const completion = await terminalCompletion(captured.completion, context.req.raw.signal);
        requestSession.finish({
          outcome: completion.outcome,
          finalProviderId: provider.id,
          finalModelId: route.modelId,
          attempt: {
            providerId: provider.id,
            modelId: route.modelId,
            providerKind: provider.kind,
            outcome: completion.outcome,
            durationMs: durationMs(attemptStartedAt),
          },
          ...(completion.outcome === "success" && completion.usage !== undefined ? { usage: completion.usage } : {}),
        });
        return Response.json(value);
      } catch (error) {
        // no-excuse-ok: catch - HTTP boundary converts provider failures.
        last = geminiProviderError(error);
        if (hasNext && shouldTryNextResponse(last)) {
          requestSession.attempt({
            providerId: provider.id,
            modelId: route.modelId,
            providerKind: provider.kind,
            ...(provider.kind === ProviderKind.Api ? { protocol: provider.protocol } : {}),
            outcome: "failure",
            statusCode: last.status,
            durationMs: durationMs(attemptStartedAt),
          });
          continue;
        }
        const outcome = isInboundAbort(error, context.req.raw.signal) ? "cancelled" : "failure";
        requestSession.finish({
          outcome,
          finalProviderId: provider.id,
          finalModelId: route.modelId,
          finalStatusCode: last.status,
          attempt: {
            providerId: provider.id,
            modelId: route.modelId,
            providerKind: provider.kind,
            ...(provider.kind === ProviderKind.Api ? { protocol: provider.protocol } : {}),
            outcome,
            statusCode: last.status,
            durationMs: durationMs(attemptStartedAt),
          },
        });
        return last;
      }
    }

    return last;
  });
}

function durationMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function isInboundAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && error instanceof Error && error.name === "AbortError";
}

function terminalCompletion(completion: Promise<UsageCompletion>, signal: AbortSignal): Promise<UsageCompletion> {
  return completion.then((value) =>
    value.outcome === "cancelled" && !signal.aborted ? { outcome: "failure" } : value,
  );
}

async function parseRequest(
  raw: Request,
  model: string,
): Promise<ReturnType<typeof parseGeminiGenerateContent> | Response> {
  try {
    const body = await raw.clone().json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return parseGeminiGenerateContent(body);
    }

    return parseGeminiGenerateContent({ ...body, model });
  } catch (error) {
    if (error instanceof GeminiInlineDataTooLargeError) {
      return geminiError(413, "RESOURCE_EXHAUSTED", error.message);
    }

    if (error instanceof SyntaxError || error instanceof ZodError) {
      return geminiError(400, "INVALID_ARGUMENT", "Invalid Gemini request");
    }

    throw error;
  }
}

function routeTarget(pathname: string): { readonly model: string; readonly stream: boolean } | undefined {
  if (!pathname.startsWith(routePrefix)) {
    return undefined;
  }

  const value = pathname.slice(routePrefix.length);
  if (value.endsWith(streamSuffix)) {
    const model = decodeURIComponent(value.slice(0, -streamSuffix.length));
    return model === "" ? undefined : { model, stream: true };
  }

  if (value.endsWith(generateSuffix)) {
    const model = decodeURIComponent(value.slice(0, -generateSuffix.length));
    return model === "" ? undefined : { model, stream: false };
  }

  return undefined;
}

function aiSdkSettings(settings: GeminiGenerateContentSettings): GeminiAiSdkSettings {
  const reasoning = geminiReasoning(settings);
  const base = {
    ...aiSdkProviderOptions(settings),
    ...(reasoning === undefined ? {} : { reasoning }),
  } satisfies GeminiAiSdkSettings;
  const parsed = aiSdkGenerationConfigSchema.safeParse(settings.generationConfig ?? {});
  if (!parsed.success) {
    return base;
  }

  const config = parsed.data;
  return {
    ...base,
    ...(config.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.maxOutputTokens }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.topP === undefined ? {} : { topP: config.topP }),
    ...(config.topK === undefined ? {} : { topK: config.topK }),
    ...(config.stopSequences === undefined ? {} : { stopSequences: config.stopSequences }),
    ...(config.seed === undefined ? {} : { seed: config.seed }),
  };
}

function geminiReasoning(settings: GeminiGenerateContentSettings): CallSettings["reasoning"] {
  const level = settings.generationConfig?.thinkingConfig?.thinkingLevel;
  if (level === undefined) {
    return undefined;
  }
  const parsed = reasoningSchema.safeParse(normalizeVariantKey(level));
  return parsed.success ? parsed.data : undefined;
}

function rewriteGeminiRequestModel(request: Request, modelId: string, stream: boolean): Request {
  const url = new URL(request.url);
  url.pathname = `${routePrefix}${encodeURIComponent(modelId)}${stream ? streamSuffix : generateSuffix}`;
  return new Request(url, request.clone());
}

function aiSdkProviderOptions(settings: GeminiGenerateContentSettings): GeminiAiSdkSettings {
  const safetySettings = jsonValue(settings.providerOptions?.google.safetySettings);

  if (safetySettings === undefined) {
    return {};
  }

  return {
    providerOptions: {
      google: { safetySettings },
    },
  };
}

function aiSdkTools(tools: readonly GeminiGenerateContentTool[] | undefined): ToolSet | undefined {
  if (tools === undefined) {
    return undefined;
  }

  const result: ToolSet = {};
  for (const tool of tools) {
    result[tool.name] = {
      type: "function",
      ...(tool.description === undefined ? {} : { description: tool.description }),
      inputSchema: jsonSchema(jsonSchemaObject(tool.inputSchema)),
      outputSchema: jsonSchema({}),
    };
  }

  return result;
}

function jsonSchemaObject(value: unknown): Parameters<typeof jsonSchema>[0] {
  const json = jsonValue(value);
  if (json === undefined || json === null || Array.isArray(json)) {
    return {};
  }

  if (typeof json === "object") {
    return json;
  }

  return {};
}

function jsonValue(value: unknown): JSONValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function geminiError(
  code: number,
  status: "INVALID_ARGUMENT" | "NOT_FOUND" | "RESOURCE_EXHAUSTED" | "UNAVAILABLE" | "UNIMPLEMENTED",
  message: string,
): Response {
  return Response.json({ error: { code, message, status } }, { status: code });
}

function geminiProviderError(error: unknown): Response {
  const missing = providerNotInstalled(error);
  if (missing !== undefined) {
    return geminiError(503, "UNAVAILABLE", missing.message);
  }

  if (error instanceof Error) {
    return geminiError(500, "UNAVAILABLE", error.message);
  }

  throw error;
}
