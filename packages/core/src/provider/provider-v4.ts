import type { ProviderV4 } from '@ai-sdk/provider';
import { isEqual, isPlainObject } from 'es-toolkit/predicate';

import { embed, embedMany, streamAiSdkText } from '../ai-sdk-bridge';
import { AiSdkProviderError, EmbeddingConvertUnsupportedError } from '../error';
import type {
  EmbeddingInvocation,
  EmbeddingProviderOptions,
  EmbeddingResult,
  EmbeddingValue,
} from '../protocol/adapter';
import type { AiSdkProviderInstance } from './ai-sdk/index';

const required = ['languageModel', 'imageModel', 'embeddingModel'] as const;
const optional = ['speechModel', 'transcriptionModel', 'rerankingModel', 'files', 'skills'] as const;

export function validateProviderV4(value: unknown): value is ProviderV4 {
  const valueType = typeof value;
  if ((valueType !== 'object' && valueType !== 'function') || value === null) {
    return false;
  }
  const candidate = value as object;
  if (Reflect.get(candidate, 'specificationVersion') !== 'v4') return false;
  return (
    required.every((name) => typeof Reflect.get(candidate, name) === 'function') &&
    optional.every((name) => {
      const method = Reflect.get(candidate, name);
      return method === undefined || typeof method === 'function';
    })
  );
}

export function createProviderV4Invoke(providerId: string, provider: ProviderV4): AiSdkProviderInstance['invoke'] {
  return (request) => {
    const settings = {
      ...request.settings,
      providerOptions: {
        ...request.settings?.providerOptions,
        aioProxy: {
          ...(request.settings?.providerOptions?.aioProxy as Record<string, unknown> | undefined),
          logicalRequest: request.context,
          routingContinuity: {
            ...request.routingContinuity,
            routedProviderId: providerId,
          },
          ...(request.providerTools === undefined || request.providerTools.length === 0
            ? {}
            : { providerTools: request.providerTools }),
        },
      },
    };
    return new ReadableStream({
      async start(controller) {
        try {
          const result = streamAiSdkText({
            model: provider.languageModel(request.modelId),
            messages: request.messages,
            settings,
            ...(request.tools === undefined ? {} : { tools: request.tools }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
          for await (const part of result.fullStream) {
            if (part.type === 'error') throw part.error;
            controller.enqueue(part);
          }
          controller.close();
        } catch (error) {
          controller.error(new AiSdkProviderError(providerId, error));
        }
      },
    });
  };
}

export type ProviderV4Embed = (
  invocation: EmbeddingInvocation,
  options: { readonly modelId: string; readonly signal?: AbortSignal; readonly logicalRequest?: unknown },
) => Promise<EmbeddingResult>;

export function createProviderV4Embed(
  providerId: string,
  provider: ProviderV4,
  deps?: { readonly embed?: typeof embed; readonly embedMany?: typeof embedMany },
): ProviderV4Embed {
  const embedFn = deps?.embed ?? embed;
  const embedManyFn = deps?.embedMany ?? embedMany;

  return async (invocation, options) => {
    try {
      assertConvertSupported(invocation.values);

      const groups = groupByProviderOptions(invocation.values);
      const embeddings: (readonly number[])[] = Array.from({ length: invocation.values.length });
      let total: number | undefined = 0;

      for (const group of groups) {
        const tokens = await embedGroup(group, {
          embedFn,
          embedManyFn,
          embeddings,
          model: provider.embeddingModel(options.modelId),
          signal: options.signal,
        });
        total = addUsage(total, tokens);
      }

      return total === undefined ? { embeddings } : { embeddings, usage: { tokens: total } };
    } catch (error) {
      if (error instanceof EmbeddingConvertUnsupportedError) throw error;
      throw new AiSdkProviderError(providerId, error);
    }
  };
}

type IndexedValue = {
  readonly index: number;
  readonly value: string;
};

type EmbeddingGroup = {
  readonly items: readonly IndexedValue[];
  readonly providerOptions: EmbeddingProviderOptions | undefined;
};

type EmbedFns = {
  readonly embedFn: typeof embed;
  readonly embedManyFn: typeof embedMany;
};

type SdkEmbedArgs = Parameters<typeof embed>[0];
type SdkEmbedManyArgs = Parameters<typeof embedMany>[0];

async function embedGroup(
  group: EmbeddingGroup,
  context: EmbedFns & {
    readonly embeddings: (readonly number[])[];
    readonly model: ReturnType<ProviderV4['embeddingModel']>;
    readonly signal: AbortSignal | undefined;
  },
): Promise<number | undefined> {
  const shared = {
    model: context.model,
    ...(group.providerOptions === undefined ? {} : { providerOptions: group.providerOptions }),
    ...(context.signal === undefined ? {} : { abortSignal: context.signal }),
  };

  if (group.items.length === 1) {
    const item = group.items[0];
    if (item === undefined) return undefined;
    const result = await context.embedFn({ ...shared, value: item.value } as SdkEmbedArgs);
    context.embeddings[item.index] = result.embedding;
    return recoverTokens(result.usage?.tokens, promptTokenCount(result.response?.body));
  }

  const result = await context.embedManyFn({
    ...shared,
    values: group.items.map((item) => item.value),
  } as SdkEmbedManyArgs);
  for (const [offset, item] of group.items.entries()) {
    const embedding = result.embeddings[offset];
    if (embedding !== undefined) context.embeddings[item.index] = embedding;
  }
  return recoverTokens(result.usage?.tokens, embedManyPromptTokenCount(result.responses));
}

function assertConvertSupported(values: readonly EmbeddingValue[]): void {
  for (const value of values) {
    const google = value.providerOptions?.['google'];
    if (google === undefined) continue;
    if (google['title'] !== undefined) throw new EmbeddingConvertUnsupportedError('title');
    if (google['autoTruncate'] !== undefined) throw new EmbeddingConvertUnsupportedError('autoTruncate');
  }
}

function groupByProviderOptions(values: readonly EmbeddingValue[]): readonly EmbeddingGroup[] {
  const groups: Array<{
    items: IndexedValue[];
    providerOptions: EmbeddingProviderOptions | undefined;
  }> = [];

  for (const [index, value] of values.entries()) {
    const providerOptions = normalizeProviderOptions(value.providerOptions);
    const existing = groups.find((group) => isEqual(group.providerOptions, providerOptions));
    if (existing === undefined) {
      groups.push({ items: [{ index, value: value.value }], providerOptions });
      continue;
    }
    existing.items.push({ index, value: value.value });
  }

  return groups;
}

function normalizeProviderOptions(options: EmbeddingProviderOptions | undefined): EmbeddingProviderOptions | undefined {
  if (options === undefined) return undefined;
  const normalized: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [namespace, value] of Object.entries(options)) {
    if (Object.keys(value).length === 0) continue;
    normalized[namespace] = value;
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function recoverTokens(tokens: unknown, fallback: unknown): number | undefined {
  if (isUsableTokenCount(tokens)) return tokens;
  if (isUsableTokenCount(fallback)) return fallback;
  return undefined;
}

function addUsage(total: number | undefined, tokens: number | undefined): number | undefined {
  if (total === undefined || tokens === undefined) return undefined;
  const next = total + tokens;
  return Number.isSafeInteger(next) && next >= 0 ? next : undefined;
}

function embedManyPromptTokenCount(responses: unknown): unknown {
  if (!Array.isArray(responses)) return undefined;
  for (const response of responses) {
    const tokens = promptTokenCount(isPlainObject(response) ? response['body'] : undefined);
    if (isUsableTokenCount(tokens)) return tokens;
  }
  return undefined;
}

function promptTokenCount(body: unknown): unknown {
  if (!isPlainObject(body)) return undefined;
  const usageMetadata = body['usageMetadata'];
  if (!isPlainObject(usageMetadata)) return undefined;
  return usageMetadata['promptTokenCount'];
}

function isUsableTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
