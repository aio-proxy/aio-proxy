import { normalizeVariantKey, ProviderProtocol } from "@aio-proxy/types";
import { z } from "zod";

import type { CallSettings, JSONValue } from "../ai-sdk-bridge";
import type { SessionCandidate } from "./session";

import { writeGeminiGenerateContentResponse, writeGeminiGenerateContentSSE } from "../egress/gemini-generate-content";
import { type GeminiGenerateContentRequest, parseGeminiGenerateContent } from "../ingress/gemini-generate-content";
import {
  type GeminiGenerateContentSettings,
  geminiGenerateContentToModelMessages,
} from "../transform/gemini-generate-content";
import { defineProtocolAdapter } from "./adapter";
import { geminiGenerateContentErrors } from "./errors";
import { readJsonRequest } from "./request";
import { functionToolSet } from "./tools";

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
const jsonValueSchema = z.json();
const reasoningSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"]);

export type GeminiRouteContext = {
  readonly model: string;
  readonly stream: boolean;
};

export const geminiGenerateContentAdapter = defineProtocolAdapter<GeminiGenerateContentRequest, GeminiRouteContext>({
  protocol: ProviderProtocol.Gemini,
  async parse(raw, context) {
    const body = await readJsonRequest(raw);
    return parseGeminiGenerateContent(
      body !== null && typeof body === "object" && !Array.isArray(body) ? { ...body, model: context.model } : body,
    );
  },
  model: (_request, context) => context.model,
  variant: (request) => request.generationConfig?.thinkingConfig?.thinkingLevel,
  session: (request) => ({
    candidates: [
      candidate("body-session", request.session_id),
      candidate("body-conversation", request.conversation_id),
    ].filter(isCandidate),
    transcript: request.contents,
  }),
  wantsStream: (_request, context) => context.stream,
  async rawRequest(raw, _request, resolvedModel, context) {
    if (context.model === resolvedModel) return raw.clone();
    const url = new URL(raw.url);
    url.pathname = `/v1beta/models/${encodeURIComponent(resolvedModel)}${
      context.stream ? ":streamGenerateContent" : ":generateContent"
    }`;
    return new Request(url, raw.clone());
  },
  modelInvocation(request) {
    const transformed = geminiGenerateContentToModelMessages(request);
    const tools = functionToolSet(transformed.tools);
    return {
      messages: transformed.messages,
      settings: aiSdkSettings(transformed.settings),
      ...(tools === undefined ? {} : { tools }),
    };
  },
  modelJson: writeGeminiGenerateContentResponse,
  modelSse: writeGeminiGenerateContentSSE,
  errors: geminiGenerateContentErrors,
});

function candidate(source: SessionCandidate["source"], value: string | undefined): SessionCandidate | undefined {
  return value === undefined ? undefined : { source, value };
}

function isCandidate(value: SessionCandidate | undefined): value is SessionCandidate {
  return value !== undefined;
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

function jsonValue(value: unknown): JSONValue | undefined {
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
