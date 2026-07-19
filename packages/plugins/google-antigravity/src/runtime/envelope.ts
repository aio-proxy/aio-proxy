import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { antigravityFamilyForWireModel, modelCapabilities } from "../catalog/families";
import { applyValidatedToolMode, normalizeFunctionDeclarations } from "../protocol/tool-schema";
import type { GoogleAntigravityCredential } from "../schema";

export type CcaRequestType = "agent" | "image_gen" | "web_search";

export type CcaRequestBody = Record<string, unknown> & {
  readonly generationConfig?: Record<string, unknown> & { readonly maxOutputTokens?: number };
  readonly labels?: Record<string, unknown> & { readonly model_enum?: string };
  readonly sessionId: string;
};

export type CcaEnvelope = {
  readonly model: string;
  readonly project: string;
  readonly userAgent: "antigravity";
  readonly requestId: string;
  readonly requestType: CcaRequestType;
  readonly request: CcaRequestBody;
};

export type CcaEnvelopeInput = {
  readonly body: Readonly<Record<string, unknown>>;
  readonly context: LogicalRequestContext;
  readonly credential: Pick<GoogleAntigravityCredential, "projectId">;
  readonly modelId: string;
  readonly requestType: CcaRequestType;
};

export function wireSessionId(key: `sha256:${string}`): string {
  const hex = new Bun.CryptoHasher("sha256").update(key).digest("hex").slice(0, 16);
  const positive = BigInt(`0x${hex}`) & ((1n << 63n) - 1n);
  return `-${positive === 0n ? 1n : positive}`;
}

export function createCcaEnvelope(input: CcaEnvelopeInput): CcaEnvelope {
  const claudeBacked = antigravityFamilyForWireModel(input.modelId)?.thinking.mode === "claude";
  const request = applyValidatedToolMode(normalizeToolDomains(cleanGeminiBody(input.body)), claudeBacked);
  return {
    model: input.modelId,
    project: input.credential.projectId,
    userAgent: "antigravity",
    requestId: `agent-${input.context.requestId}`,
    requestType: input.requestType,
    request: applyWireProfile(request, input.modelId, input.context.session.key),
  };
}

function normalizeToolDomains(body: Record<string, unknown> & { readonly tools?: unknown }): Record<string, unknown> {
  const domains = body.tools;
  if (domains === undefined) return body;
  if (!Array.isArray(domains)) throw new TypeError("Gemini tools must be an array");
  const tools = domains.flatMap((value): Record<string, unknown>[] => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError("Gemini tool domains must be objects");
    }
    const { functionDeclarations, ...domains } = value as Record<string, unknown>;
    if (functionDeclarations === undefined) return [{ ...domains }];
    const declarations = normalizeFunctionDeclarations(functionDeclarations);
    if (declarations.length === 0) return Object.keys(domains).length === 0 ? [] : [{ ...domains }];
    return [{ ...domains, functionDeclarations: declarations }];
  });
  const { tools: _tools, ...request } = body;
  return tools.length === 0 ? request : { ...request, tools };
}

function cleanGeminiBody(body: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { safetySettings: _safetySettings, ...cleaned } = body;
  return cleaned;
}

function applyWireProfile(
  body: Record<string, unknown>,
  modelId: string,
  sessionKey: `sha256:${string}`,
): CcaRequestBody {
  const profile = modelCapabilities(modelId);
  const generationConfig = record(Reflect.get(body, "generationConfig"));
  const labels = record(Reflect.get(body, "labels"));
  const explicitLimit = generationConfig === undefined ? undefined : Reflect.get(generationConfig, "maxOutputTokens");
  return {
    ...body,
    ...(profile === undefined
      ? {}
      : {
          generationConfig: {
            ...generationConfig,
            maxOutputTokens:
              typeof explicitLimit === "number" && Number.isFinite(explicitLimit)
                ? Math.min(explicitLimit, profile.maxOutputTokens)
                : profile.maxOutputTokens,
          },
          ...(profile.modelEnum === undefined ? {} : { labels: { ...labels, model_enum: profile.modelEnum } }),
        }),
    sessionId: wireSessionId(sessionKey),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
