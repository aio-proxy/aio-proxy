import type { LogicalRequestContext, ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';
import { isRecord } from '@aio-proxy/types';

import { classifyProvider } from '../catalog/classify';
import type { AntigravityFamily, Effort } from '../catalog/collapse';
import { applyValidatedToolMode, normalizeFunctionDeclarations } from '../protocol/tool-schema';
import type { GoogleAntigravityCredential } from '../schema';

export type CcaRequestType = 'agent' | 'image_gen' | 'web_search';

export type CcaRequestBody = Record<string, unknown> & {
  readonly generationConfig?: Record<string, unknown> & { readonly maxOutputTokens?: number };
  readonly labels?: Record<string, unknown> & { readonly model_enum?: string };
  readonly sessionId: string;
};

export type CcaEnvelope = {
  readonly model: string;
  readonly project: string;
  readonly userAgent: 'antigravity';
  readonly requestId: string;
  readonly requestType: CcaRequestType;
  readonly request: CcaRequestBody;
};

export type CcaWireLookups = {
  readonly descriptorById?: ReadonlyMap<string, ModelDescriptor>;
  readonly familyByWireId?: (modelId: string) => AntigravityFamily | undefined;
};

export type CcaEnvelopeInput = {
  readonly body: Readonly<Record<string, unknown>>;
  readonly context: LogicalRequestContext;
  readonly credential: Pick<GoogleAntigravityCredential, 'projectId'>;
  readonly modelId: string;
  readonly requestType: CcaRequestType;
} & CcaWireLookups;

export function createCatalogWireLookups(catalog: ModelCatalog): Required<CcaWireLookups> {
  const descriptorById = new Map(catalog.language.map((model) => [model.id, model]));
  const byWire = new Map<string, AntigravityFamily>();
  for (const family of readAntigravityFamilies(catalog.extra)) {
    byWire.set(family.base, family);
    for (const variant of family.variants) byWire.set(variant.model, family);
  }
  return {
    descriptorById,
    familyByWireId: (modelId) => byWire.get(modelId),
  };
}

export function wireSessionId(key: `sha256:${string}`): string {
  const hex = new Bun.CryptoHasher('sha256').update(key).digest('hex').slice(0, 16);
  const positive = BigInt(`0x${hex}`) & ((1n << 63n) - 1n);
  return `-${positive === 0n ? 1n : positive}`;
}

export function createCcaEnvelope(input: CcaEnvelopeInput): CcaEnvelope {
  const descriptor = input.descriptorById?.get(input.modelId);
  const claudeBacked =
    input.familyByWireId?.(input.modelId)?.thinking.mode === 'claude' ||
    classifyProvider(descriptor ?? {}) === 'claude';
  const request = applyValidatedToolMode(normalizeToolDomains(cleanGeminiBody(input.body)), claudeBacked);
  return {
    model: input.modelId,
    project: input.credential.projectId,
    userAgent: 'antigravity',
    requestId: `agent-${input.context.requestId}`,
    requestType: input.requestType,
    request: applyWireProfile(request, input.context.session.key, descriptor),
  };
}

function normalizeToolDomains(body: Record<string, unknown> & { readonly tools?: unknown }): Record<string, unknown> {
  const domains = body.tools;
  if (domains === undefined) return body;
  if (!Array.isArray(domains)) throw new TypeError('Gemini tools must be an array');
  const tools = domains.flatMap((value): Record<string, unknown>[] => {
    if (!isRecord(value)) {
      throw new TypeError('Gemini tool domains must be objects');
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
  sessionKey: `sha256:${string}`,
  descriptor: ModelDescriptor | undefined,
): CcaRequestBody {
  const profile = wireProfile(descriptor);
  const generationConfig = record(Reflect.get(body, 'generationConfig'));
  const labels = record(Reflect.get(body, 'labels'));
  const explicitLimit = generationConfig === undefined ? undefined : Reflect.get(generationConfig, 'maxOutputTokens');
  const maxOutputTokens =
    profile.maxOutputTokens === undefined
      ? undefined
      : typeof explicitLimit === 'number' && Number.isFinite(explicitLimit)
        ? Math.min(explicitLimit, profile.maxOutputTokens)
        : profile.maxOutputTokens;
  return {
    ...body,
    ...(maxOutputTokens === undefined ? {} : { generationConfig: { ...generationConfig, maxOutputTokens } }),
    ...(profile.modelEnum === undefined ? {} : { labels: { ...labels, model_enum: profile.modelEnum } }),
    sessionId: wireSessionId(sessionKey),
  };
}

function wireProfile(descriptor: ModelDescriptor | undefined) {
  const source = providerSource(descriptor?.extra);
  return {
    maxOutputTokens: finitePositive(source?.['maxOutputTokens']),
    modelEnum: asString(source?.['modelEnum']),
  };
}

function readAntigravityFamilies(extra: unknown): readonly AntigravityFamily[] {
  if (!isRecord(extra) || !Array.isArray(extra['antigravityFamilies'])) return [];
  const families: AntigravityFamily[] = [];
  for (const value of extra['antigravityFamilies']) {
    const family = asFamily(value);
    if (family !== undefined) families.push(family);
  }
  return families;
}

function asFamily(value: unknown): AntigravityFamily | undefined {
  if (!isRecord(value)) return undefined;
  const logicalId = asString(value['logicalId']);
  const base = asString(value['base']);
  const kind = value['kind'];
  const thinking = value['thinking'];
  const thinkingMode = isRecord(thinking) ? thinking['mode'] : undefined;
  if (logicalId === undefined || base === undefined) return undefined;
  if (kind !== 'split' && kind !== 'tiered' && kind !== 'same-wire') return undefined;
  if (thinkingMode !== 'gemini' && thinkingMode !== 'claude' && thinkingMode !== 'none') return undefined;
  if (!Array.isArray(value['variants'])) return undefined;
  const variants: { effort: Effort; model: string }[] = [];
  for (const row of value['variants']) {
    if (!isRecord(row)) continue;
    const effort = row['effort'];
    const model = asString(row['model']);
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') continue;
    if (model === undefined) continue;
    variants.push({ effort, model });
  }
  return { logicalId, kind, thinking: { mode: thinkingMode }, base, variants };
}

function providerSource(extra: unknown): Record<string, unknown> | undefined {
  if (!isRecord(extra)) return undefined;
  return isRecord(extra['antigravity']) ? extra['antigravity'] : extra;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
