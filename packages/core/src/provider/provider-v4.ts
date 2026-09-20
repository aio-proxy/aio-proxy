import type {
  Experimental_EvaluationModelV4,
  Experimental_EvaluationModelV4Input,
  Experimental_EvaluationModelV4Question,
  Experimental_EvaluationModelV4Result,
  ProviderV4,
} from '@ai-sdk/provider';
import { isRecord } from '@aio-proxy/shared';
import { experimental_evaluate } from 'ai';
import { isPlainObject } from 'es-toolkit/predicate';

import { embed, embedMany, streamAiSdkText } from '../ai-sdk-bridge';
import { AiSdkProviderError, EmbeddingConvertUnsupportedError, EmbeddingCountMismatchError } from '../error';
import type {
  EmbeddingInvocation,
  EmbeddingProviderOptions,
  EmbeddingResult,
  EmbeddingValue,
  EvaluationAnswer,
  EvaluationInvocation,
  EvaluationResult,
} from '../protocol/adapter';
import type { AiSdkProviderInstance } from './ai-sdk/index';

const required = ['languageModel', 'imageModel', 'embeddingModel'] as const;
const optional = ['speechModel', 'transcriptionModel', 'rerankingModel', 'files', 'skills'] as const;
// Official Gemini batchEmbedContents is 100 items. Convert fans one SDK call per
// distinct option group, so this is also the max sequential upstream fan-out.
const MAX_EMBEDDING_CONVERT_GROUPS = 100;

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
      if (groups.length > MAX_EMBEDDING_CONVERT_GROUPS) {
        throw new EmbeddingConvertUnsupportedError('distinct-option groups');
      }
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
    if (result.embedding === undefined) throw new EmbeddingCountMismatchError(1, 0);
    context.embeddings[item.index] = result.embedding;
    return recoverTokens(result.usage?.tokens, promptTokenCount(result.response?.body));
  }

  const result = await context.embedManyFn({
    ...shared,
    values: group.items.map((item) => item.value),
  } as SdkEmbedManyArgs);
  // A short or padded batch would otherwise leave holes in the preallocated
  // array and reach egress as a corrupt body or a TypeError.
  if (result.embeddings.length !== group.items.length) {
    throw new EmbeddingCountMismatchError(group.items.length, result.embeddings.length);
  }
  for (const [offset, item] of group.items.entries()) {
    const embedding = result.embeddings[offset];
    if (embedding === undefined) throw new EmbeddingCountMismatchError(group.items.length, offset);
    context.embeddings[item.index] = embedding;
  }
  return recoverTokens(result.usage?.tokens, embedManyPromptTokenCount(result.responses));
}

// `@ai-sdk/google` parses neither option and never writes it onto the upstream
// body, so converting a request that carries one would silently drop it.
export function assertConvertSupported(values: readonly EmbeddingValue[]): void {
  for (const value of values) {
    const google = value.providerOptions?.['google'];
    if (google === undefined) continue;
    if (google['title'] !== undefined) throw new EmbeddingConvertUnsupportedError('title');
    if (google['autoTruncate'] !== undefined) throw new EmbeddingConvertUnsupportedError('autoTruncate');
  }
}

type ResolvedProviderOptions = {
  readonly key: string;
  readonly providerOptions: EmbeddingProviderOptions | undefined;
};

function groupByProviderOptions(values: readonly EmbeddingValue[]): readonly EmbeddingGroup[] {
  const groups = new Map<
    string,
    {
      items: IndexedValue[];
      providerOptions: EmbeddingProviderOptions | undefined;
    }
  >();
  // OpenAI convert shares one options object across every input. Fingerprint it
  // once; canonicalize+stringify per value is a sync DoS on a large `user`.
  const resolvedBySource = new WeakMap<EmbeddingProviderOptions, ResolvedProviderOptions>();

  for (const [index, value] of values.entries()) {
    const resolved = resolveProviderOptions(value.providerOptions, resolvedBySource);
    const existing = groups.get(resolved.key);
    if (existing === undefined) {
      groups.set(resolved.key, {
        items: [{ index, value: value.value }],
        providerOptions: resolved.providerOptions,
      });
      continue;
    }
    existing.items.push({ index, value: value.value });
  }

  return [...groups.values()];
}

function resolveProviderOptions(
  source: EmbeddingProviderOptions | undefined,
  cache: WeakMap<EmbeddingProviderOptions, ResolvedProviderOptions>,
): ResolvedProviderOptions {
  if (source === undefined) return { key: '', providerOptions: undefined };
  const cached = cache.get(source);
  if (cached !== undefined) return cached;
  const providerOptions = normalizeProviderOptions(source);
  const resolved = { key: providerOptionsKey(providerOptions), providerOptions };
  cache.set(source, resolved);
  return resolved;
}

function providerOptionsKey(options: EmbeddingProviderOptions | undefined): string {
  return options === undefined ? '' : JSON.stringify(canonicalize(options));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = canonicalize(value[key]);
  }
  return normalized;
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
  if (!Array.isArray(responses) || responses.length === 0) return undefined;
  let total: number | undefined = 0;
  for (const response of responses) {
    const tokens = promptTokenCount(isPlainObject(response) ? response['body'] : undefined);
    if (!isUsableTokenCount(tokens)) return undefined;
    total = addUsage(total, tokens);
    if (total === undefined) return undefined;
  }
  return total;
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

export type ProviderV4EvaluateOptions = {
  readonly modelId: string;
  readonly signal?: AbortSignal;
};

export type ProviderV4EvaluateTransport = {
  readonly evaluate: (
    invocation: EvaluationInvocation,
    options: ProviderV4EvaluateOptions,
  ) => Promise<EvaluationResult>;
};

export function createProviderV4Evaluate(providerId: string, provider: unknown): ProviderV4EvaluateTransport {
  if (!isRecord(provider) || typeof provider['evaluationModel'] !== 'function') {
    throw new AiSdkProviderError(providerId, 'ai-sdk provider does not expose an evaluation model resolver');
  }
  const resolveModel = provider['evaluationModel'] as (modelId: string) => unknown;

  return {
    async evaluate(invocation, options) {
      const result = await experimental_evaluate({
        model: asEvaluationModel(providerId, resolveModel(options.modelId)),
        state: invocation.state as Experimental_EvaluationModelV4Input,
        questions: toSdkQuestions(invocation),
        // The pipeline owns retry and fallback. An SDK-level retry would hide the
        // extra attempts from traces and double this candidate's time budget.
        maxRetries: 0,
        ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      });

      const answers = Object.fromEntries(
        Object.entries(result.answers).map(([id, answer]): [string, EvaluationAnswer] => [
          id,
          toEvaluationAnswer(id, answer, result.providerMetadata),
        ]),
      );
      const usage = toEvaluationUsage(result.usage);
      return { answers, ...(usage === undefined ? {} : { usage }) };
    },
  };
}

type SdkEvaluationAnswer = Experimental_EvaluationModelV4Result['answers'][string];

// `experimental_evaluate` accepts `string | Experimental_EvaluationModelV4`, and at
// ai@7.0.107 a bare string id resolves through `AI_SDK_DEFAULT_PROVIDER ?? gateway`. A
// package whose `evaluationModel` returned the id instead of a model would therefore
// route to Gateway instead of the candidate the pipeline selected, succeed against the
// wrong provider, and bill the wrong account — silently, because the answers still come
// back well formed. The resolver is untyped, so this rejects anything that is not a real
// v4 model instance rather than casting the hazard away. `specificationVersion` is
// mandatory on the contract, so it is a reliable marker. The sibling embedding wrapper
// needs no such guard: `embed` has no string overload, so a stray string fails there.
function asEvaluationModel(providerId: string, model: unknown): Experimental_EvaluationModelV4 {
  if (!isRecord(model) || model['specificationVersion'] !== 'v4') {
    throw new AiSdkProviderError(providerId, 'ai-sdk provider did not resolve an evaluation model instance');
  }
  return model as unknown as Experimental_EvaluationModelV4;
}

// SDK questions use `boolean` where the System One wire uses `noul`. Only that
// envelope is rebuilt: `validateEvaluationInput` accepts choice/score questions
// unchanged, so passing them through verbatim is both correct and cheaper.
function toSdkQuestions(invocation: EvaluationInvocation): Record<string, Experimental_EvaluationModelV4Question> {
  return Object.fromEntries(
    Object.entries(invocation.questions).map(([id, question]): [string, Experimental_EvaluationModelV4Question] => [
      id,
      (question.type === 'noul'
        ? { ...question, type: 'boolean' }
        : question) as Experimental_EvaluationModelV4Question,
    ]),
  );
}

function toEvaluationAnswer(id: string, answer: SdkEvaluationAnswer, metadata: unknown): EvaluationAnswer {
  // A noul answer carries no confidence: `probability` is already P(true).
  if (answer.type === 'boolean') {
    return { type: 'noul', noul: answer.probability };
  }

  const confidence = confidenceFor(metadata, id);
  const extras = {
    // Distributions pass through untouched. Refusing an absent one is egress's
    // concern, not the transport's.
    ...(answer.probabilities === undefined ? {} : { probabilities: answer.probabilities }),
    ...(confidence === undefined ? {} : { confidence }),
  };
  return answer.type === 'choice'
    ? { type: 'choice', choice: answer.choice, ...extras }
    : { type: 'score', score: answer.score, ...extras };
}

// `confidence` has no home in the SDK's neutral answer shape, so TypeSafe reports
// it as provider metadata keyed by question id.
function confidenceFor(metadata: unknown, id: string): number | undefined {
  if (!isRecord(metadata)) return undefined;
  const typesafe = metadata['typesafe'];
  if (!isRecord(typesafe)) return undefined;
  const confidence = typesafe['confidence'];
  if (!isRecord(confidence)) return undefined;
  const value = confidence[id];
  return typeof value === 'number' ? value : undefined;
}

function toEvaluationUsage(usage: Experimental_EvaluationModelV4Result['usage']): EvaluationResult['usage'] {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}
