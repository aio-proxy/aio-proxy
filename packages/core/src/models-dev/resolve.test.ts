import { expect, test } from 'bun:test';

import type { Model, Provider, ProviderMap } from '@opencode-ai/models';

import { resolveModelEntry } from './resolve';

const model = (id: string): Model => ({
  attachment: false,
  description: '',
  id,
  last_updated: '2026-01-15',
  limit: { context: 128_000, output: 8_000 },
  modalities: { input: ['text'], output: ['text'] },
  name: id,
  open_weights: false,
  reasoning: false,
  release_date: '2026-01-15',
  tool_call: false,
});

const provider = (id: string, models: Record<string, Model>): Provider => ({
  doc: `https://example.com/${id}`,
  env: [],
  id,
  models,
  name: id,
  npm: `@ai-sdk/${id}`,
});

const providerMap: ProviderMap = {
  openai: provider('openai', { 'gpt-5': model('gpt-5') }),
  anthropic: provider('anthropic', { 'claude-4': model('claude-4') }),
  google: provider('google', { 'gemini-2': model('gemini-2') }),
  openrouter: provider('openrouter', {
    'vendor/mistral-large': model('vendor/mistral-large'),
  }),
};

test('an explicit provider/model slug is the canonical extend target', () => {
  expect(resolveModelEntry(providerMap, 'openai/gpt-5')?.slug).toBe('openai/gpt-5');
});

test('a gpt-* public slug falls back to the OpenAI catalog entry', () => {
  expect(resolveModelEntry(providerMap, 'gpt-5')?.slug).toBe('openai/gpt-5');
});

test('a claude-* public slug falls back to the Anthropic catalog entry', () => {
  expect(resolveModelEntry(providerMap, 'claude-4')?.slug).toBe('anthropic/claude-4');
});

test('a gemini-* public slug falls back to the Google catalog entry', () => {
  expect(resolveModelEntry(providerMap, 'gemini-2')?.slug).toBe('google/gemini-2');
});

test('an unmatched id falls back to OpenRouter by full or bare model id', () => {
  expect(resolveModelEntry(providerMap, 'vendor/mistral-large')?.slug).toBe('openrouter/vendor/mistral-large');
  expect(resolveModelEntry(providerMap, 'mistral-large')?.slug).toBe('openrouter/vendor/mistral-large');
});

test('an unknown id has no fallback slug', () => {
  expect(resolveModelEntry(providerMap, 'mystery-model')).toBeUndefined();
});

test('survives a cached provider entry that has no models at all', () => {
  // The cache is parsed without a schema, so `provider.models` is a compile-time fiction and a
  // hand-edited or truncated file really can hold this shape. Indexing it threw, and because the
  // routing inventory awaits this lookup unguarded, one malformed entry took the whole routing page
  // down instead of merely omitting that model's catalog facts.
  const malformed = { anthropic: {} } as unknown as ProviderMap;

  // The explicit provider/model path, the provider-glob path, and the OpenRouter fallback.
  expect(resolveModelEntry(malformed, 'anthropic/claude-x')).toBeUndefined();
  expect(resolveModelEntry(malformed, 'claude-3-5-sonnet')).toBeUndefined();
  expect(resolveModelEntry({ openrouter: {} } as unknown as ProviderMap, 'gpt-5')).toBeUndefined();
});

test('still resolves the healthy providers beside a malformed one', () => {
  // Degrading must not mean giving up on the rest of the catalog.
  const mixed = { broken: {}, anthropic: provider('anthropic', { 'claude-x': model('claude-x') }) } as ProviderMap;

  expect(resolveModelEntry(mixed, 'anthropic/claude-x')?.slug).toBe('anthropic/claude-x');
});
