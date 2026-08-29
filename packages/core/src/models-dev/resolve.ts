import type { Model, ProviderMap } from '@opencode-ai/models';
import { Glob } from 'bun';

// models.dev provider id -> glob patterns whose model ids pin to that provider.
// Add a pattern (or provider) here to extend prefix-based resolution.
const PROVIDER_MODEL_PATTERNS: Record<string, readonly string[]> = {
  alibaba: ['qwen-*'],
  anthropic: ['claude-*'],
  'bytedance-seed': ['seed-*', 'doubao-*'],
  deepseek: ['deepseek-*'],
  google: ['gemini-*', 'gemma-*'],
  meta: ['llama-*', 'muse-*'],
  minimax: ['MiniMax-*'],
  moonshotai: ['kimi-*'],
  nvidia: ['nemotron-*'],
  openai: ['gpt-*'],
  tencent: ['hy*'],
  xai: ['grok-*'],
  xiaomi: ['mimo-*'],
  zhipuai: ['glm-*'],
};

// Precompiled once: each provider's patterns flattened into [providerId, Glob]
// pairs, matched in declaration order.
const PROVIDER_GLOBS: readonly (readonly [string, Glob])[] = Object.entries(PROVIDER_MODEL_PATTERNS).flatMap(
  ([providerId, patterns]) => patterns.map((pattern) => [providerId, new Glob(pattern)] as const),
);

export type ResolvedModelsDevEntry = {
  readonly slug: string;
  readonly model: Model;
};

export function resolveModelEntry(providerMap: ProviderMap, modelId: string): ResolvedModelsDevEntry | undefined {
  // Explicit provider/model id wins. Split on the first slash only, so a
  // multi-segment id like `openrouter/vendor/mistral-large` keeps its full
  // `vendor/mistral-large` model id instead of being truncated to `vendor`.
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const providerId = modelId.slice(0, slash);
    const providerModelId = modelId.slice(slash + 1);
    const hit = providerMap[providerId]?.models[providerModelId];
    if (hit) return { slug: `${providerId}/${providerModelId}`, model: hit };
  }
  // A model id matching a known provider pattern pins that provider.
  for (const [providerId, glob] of PROVIDER_GLOBS) {
    if (glob.match(modelId)) {
      const hit = providerMap[providerId]?.models[modelId];
      if (hit) return { slug: `${providerId}/${modelId}`, model: hit };
      break;
    }
  }
  // Fall back to OpenRouter, matching the full id or its bare model id.
  for (const [key, model] of Object.entries(providerMap['openrouter']?.models ?? {})) {
    if (model.id === modelId || model.id.split('/', 2)[1] === modelId) {
      return { slug: `openrouter/${key}`, model };
    }
  }
  return undefined;
}

export function resolveModel(providerMap: ProviderMap, modelId: string): Model | undefined {
  return resolveModelEntry(providerMap, modelId)?.model;
}
