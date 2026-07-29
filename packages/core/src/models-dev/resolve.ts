import type { Model, ProviderMap } from '@opencode-ai/models';
import { Glob } from 'bun';

// models.dev provider id -> glob patterns whose model ids pin to that provider.
// Add a pattern (or provider) here to extend prefix-based resolution.
const PROVIDER_MODEL_PATTERNS: Record<string, readonly string[]> = {
  openai: ['gpt-*'],
  anthropic: ['claude-*'],
  google: ['gemini-*'],
};

// Precompiled once: each provider's patterns flattened into [providerId, Glob]
// pairs, matched in declaration order.
const PROVIDER_GLOBS: readonly (readonly [string, Glob])[] = Object.entries(PROVIDER_MODEL_PATTERNS).flatMap(
  ([providerId, patterns]) => patterns.map((pattern) => [providerId, new Glob(pattern)] as const),
);

export function resolveModel(providerMap: ProviderMap, modelId: string): Model | undefined {
  // Explicit provider/model id wins. Split on the first slash only, so a
  // multi-segment id like `openrouter/vendor/mistral-large` keeps its full
  // `vendor/mistral-large` model id instead of being truncated to `vendor`.
  const slash = modelId.indexOf('/');
  if (slash > 0) {
    const providerId = modelId.slice(0, slash);
    const providerModelId = modelId.slice(slash + 1);
    const hit = providerMap[providerId]?.models[providerModelId];
    if (hit) return hit;
  }
  // A model id matching a known provider pattern pins that provider.
  for (const [providerId, glob] of PROVIDER_GLOBS) {
    if (glob.match(modelId)) {
      const hit = providerMap[providerId]?.models[modelId];
      if (hit) return hit;
      break;
    }
  }
  // Fall back to OpenRouter, matching the full id or its bare model id.
  return Object.values(providerMap['openrouter']?.models ?? {}).find(
    (m) => m.id === modelId || m.id.split('/', 2)[1] === modelId,
  );
}
