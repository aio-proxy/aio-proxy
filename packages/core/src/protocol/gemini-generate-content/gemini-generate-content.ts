import { canonicalEffort, normalizeVariantKey, ProviderProtocol } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import type { AiSdkCallSettings, JSONValue } from '../../ai-sdk-bridge';
import {
  writeGeminiGenerateContentResponse,
  writeGeminiGenerateContentSSE,
} from '../../egress/gemini-generate-content';
import {
  type GeminiGenerateContentRequest,
  parseGeminiGenerateContent,
} from '../../ingress/gemini-generate-content/index';
import {
  type GeminiGenerateContentSettings,
  geminiGenerateContentToModelMessages,
} from '../../transform/gemini-generate-content/index';
import { defineProtocolAdapter } from '../adapter';
import { geminiGenerateContentErrors } from '../errors';
import { clampSdkReasoning, normalizeEffort } from '../reasoning-effort/index';
import { readJsonRequest, readRequestText } from '../request';
import type { SessionCandidate } from '../session';
import { functionToolSet } from '../tools';

type GeminiAiSdkSettings = AiSdkCallSettings & {
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
const reasoningSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

export type GeminiRouteContext = {
  readonly model: string;
  readonly stream: boolean;
};

export const geminiGenerateContentAdapter = defineProtocolAdapter<GeminiGenerateContentRequest, GeminiRouteContext>({
  protocol: ProviderProtocol.Gemini,
  async parse(raw, context) {
    const body = await readJsonRequest(raw);
    return parseGeminiGenerateContent(isPlainObject(body) ? { ...body, model: context.model } : body);
  },
  model: (_request, context) => context.model,
  dimensions: (request) => {
    const level = request.generationConfig?.thinkingConfig?.thinkingLevel;
    if (level === undefined) return {};
    // OFF turns thinking off entirely; NONE is zero-effort *thinking* and must
    // keep its effort axis rather than collapsing into OFF.
    if (normalizeVariantKey(level) === 'off') return { thinking: false };
    return { thinking: true, effort: canonicalEffort(level) };
  },
  session: (request) => ({
    candidates: [
      candidate('body-session', request.session_id),
      candidate('body-conversation', request.conversation_id),
    ].filter(isCandidate),
    transcript: request.contents,
  }),
  wantsStream: (_request, context) => context.stream,
  async rawRequest(raw, _request, resolvedModel, supportedEfforts, context) {
    const url = new URL(raw.url);
    url.pathname = `/v1beta/models/${encodeURIComponent(resolvedModel)}${
      context.stream ? ':streamGenerateContent' : ':generateContent'
    }`;
    // Read the decoded body text once so a no-op clamp can forward it verbatim.
    const bodyText = await readRequestText(raw);
    const body = rawBodySchema.parse(JSON.parse(bodyText));
    const rewrittenBody = clampThinkingLevel(body, supportedEfforts);
    const headers = new Headers(raw.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    // Gemini rewrites the model in the URL, not the body. When the effort was
    // not clamped, forward the original body bytes verbatim (re-serializing
    // would drop the client's whitespace); only re-serialize on an actual change.
    const forwardedBody = rewrittenBody === body ? bodyText : JSON.stringify(rewrittenBody);
    // Build from the URL (the model lives in the path, not the body), but carry
    // the inbound abort signal through: without it a client disconnect leaves a
    // fresh non-aborted signal on the rewritten request, so raw transports that
    // honour request.signal keep the upstream generation (and billing) running.
    return new Request(url, {
      method: raw.method,
      headers,
      body: forwardedBody,
      signal: raw.signal,
    });
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
  modelInvocationForTarget(invocation, _targetProtocol, supportedEfforts) {
    return clampSdkReasoning(invocation, supportedEfforts);
  },
  modelJson: writeGeminiGenerateContentResponse,
  modelSse: writeGeminiGenerateContentSSE,
  errors: geminiGenerateContentErrors,
});

function candidate(source: SessionCandidate['source'], value: string | undefined): SessionCandidate | undefined {
  return value === undefined ? undefined : { source, value };
}

const rawBodySchema = z.object({}).catchall(z.unknown());

type RawGeminiBody = z.infer<typeof rawBodySchema>;

// Clamp generationConfig.thinkingConfig.thinkingLevel (a string) down to the
// upstream's supported effort set. Non-string/absent levels pass through so the
// body is forwarded untouched apart from re-serialization.
//
// Gemini's wire enum is UPPERCASE (`LOW`/`MEDIUM`/`HIGH`), while normalizeEffort
// yields the canonical lowercase ladder value. Only rewrite when the request is
// genuinely downgraded to a different level; when the level is unchanged (e.g. a
// supported `HIGH`, differing from the canonical `high` only in casing) forward
// the original spelling verbatim. On a real downgrade, re-emit in Gemini's
// uppercase spelling so the forwarded body stays a valid Gemini request.
function clampThinkingLevel(body: RawGeminiBody, supported: ReadonlySet<string>): RawGeminiBody {
  const generationConfig = asRecord(body['generationConfig']);
  if (generationConfig === undefined) return body;
  const thinkingConfig = asRecord(generationConfig['thinkingConfig']);
  if (thinkingConfig === undefined) return body;
  const level = thinkingConfig['thinkingLevel'];
  if (typeof level !== 'string') return body;
  const normalized = normalizeEffort(level, supported);
  // Casing-only difference (or exact match) is not a downgrade: keep the wire value.
  if (normalized.toLowerCase() === level.toLowerCase()) return body;
  const next = normalized.toUpperCase();
  return {
    ...body,
    generationConfig: { ...generationConfig, thinkingConfig: { ...thinkingConfig, thinkingLevel: next } },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
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

function geminiReasoning(settings: GeminiGenerateContentSettings): AiSdkCallSettings['reasoning'] {
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
