import { describe, expect, test } from 'bun:test';

import type { Model, Provider, ProviderMap } from '@opencode-ai/models';

import { findModelPrice } from './price';

const model = (id: string, cost?: Model['cost']): Model => ({
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
  ...(cost === undefined ? {} : { cost }),
});

const provider = (id: string, models: Record<string, Model>): Provider => ({
  doc: `https://example.com/${id}`,
  env: [],
  id,
  models,
  name: id,
  npm: `@ai-sdk/${id}`,
});

describe('findModelPrice', () => {
  test('derives price from an OpenRouter cost record, including optional fields', () => {
    const providers: ProviderMap = {
      openrouter: provider('openrouter', {
        'openai/gpt-5': model('openai/gpt-5', {
          input: 2,
          output: 10,
          cache_read: 1,
          cache_write: 3,
          reasoning: 5,
        }),
      }),
    };
    expect(findModelPrice(providers, 'openai/gpt-5')).toEqual({
      id: 'openai/gpt-5',
      input: 2,
      output: 10,
      cacheRead: 1,
      cacheWrite: 3,
      reasoning: 5,
    });
  });

  test('matches an unambiguous bare id', () => {
    const providers: ProviderMap = {
      openrouter: provider('openrouter', {
        'anthropic/claude-4': model('anthropic/claude-4', { input: 3, output: 15 }),
      }),
    };
    expect(findModelPrice(providers, 'claude-4')?.id).toBe('anthropic/claude-4');
  });

  test('returns the first vendor for an ambiguous bare id shared across vendors', () => {
    const providers: ProviderMap = {
      openrouter: provider('openrouter', {
        'a/mistral-large': model('a/mistral-large', { input: 1, output: 2 }),
        'b/mistral-large': model('b/mistral-large', { input: 9, output: 9 }),
      }),
    };
    // Bare-id resolution mirrors model lookup: the first catalog match wins.
    expect(findModelPrice(providers, 'mistral-large')?.id).toBe('a/mistral-large');
    // Full ids still resolve to each vendor.
    expect(findModelPrice(providers, 'a/mistral-large')?.input).toBe(1);
    expect(findModelPrice(providers, 'b/mistral-large')?.input).toBe(9);
  });

  test('prices a prefix-pinned id from its dedicated provider catalog', () => {
    const providers: ProviderMap = {
      anthropic: provider('anthropic', { 'claude-opus-4-8': model('claude-opus-4-8', { input: 5, output: 25 }) }),
      openai: provider('openai', { 'gpt-5': model('gpt-5', { input: 2, output: 10 }) }),
      google: provider('google', { 'gemini-3-pro': model('gemini-3-pro', { input: 1, output: 4 }) }),
    };
    // claude-/gpt-/gemini- ids pin to their provider even without an OpenRouter entry.
    expect(findModelPrice(providers, 'claude-opus-4-8')).toEqual({ id: 'claude-opus-4-8', input: 5, output: 25 });
    expect(findModelPrice(providers, 'gpt-5')?.input).toBe(2);
    expect(findModelPrice(providers, 'gemini-3-pro')?.output).toBe(4);
  });

  test('does not price an unknown-prefix id that only a non-catalog provider lists', () => {
    const providers: ProviderMap = {
      cohere: provider('cohere', { 'command-r': model('command-r', { input: 2, output: 10 }) }),
    };
    expect(findModelPrice(providers, 'command-r')).toBeUndefined();
  });

  test('skips models without cost', () => {
    const providers: ProviderMap = {
      openrouter: provider('openrouter', { 'x/free': model('x/free') }),
    };
    expect(findModelPrice(providers, 'x/free')).toBeUndefined();
  });
});
