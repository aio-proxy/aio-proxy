import { describe, expect, it } from 'bun:test';

import type { Model } from '@opencode-ai/models';

import { catalogModelToMetadata } from './catalog-metadata';

// A representative catalog model exercising camelCasing, the budget_tokens
// reasoning variant, the legacy context_over_200k synthesis, and optional-field
// omission. Values are distinct so a mis-mapping surfaces as a wrong number.
function baseModel(): Model {
  return {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    description: 'A capable model.',
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens', min: -1, max: 32_000 }],
    tool_call: true,
    structured_output: true,
    knowledge: '2025-01',
    release_date: '2026-05-01',
    last_updated: '2026-06-01',
    modalities: { input: ['text', 'image'], output: ['text'] },
    open_weights: false,
    limit: { context: 200_000, input: 190_000, output: 64_000 },
    cost: {
      input: 3,
      output: 15,
      cache_read: 0.3,
      input_audio: 5,
      context_over_200k: { input: 6, output: 30, cache_read: 0.6 },
    },
  };
}

describe('catalogModelToMetadata', () => {
  it('camelCases fields and synthesizes a 200k tier from context_over_200k', () => {
    const metadata = catalogModelToMetadata(baseModel());

    expect(metadata.name).toBe('Claude Opus 4.6');
    expect(metadata.description).toBe('A capable model.');
    expect(metadata.limit).toEqual({ context: 200_000, input: 190_000, output: 64_000 });

    const capabilities = metadata.capabilities;
    expect(capabilities?.toolCall).toBe(true);
    expect(capabilities?.structuredOutput).toBe(true);
    expect(capabilities?.attachment).toBe(true);
    expect(capabilities?.reasoning).toBe(true);
    expect(capabilities?.releaseDate).toBe('2026-05-01');
    expect(capabilities?.lastUpdated).toBe('2026-06-01');
    expect(capabilities?.knowledge).toBe('2025-01');
    expect(capabilities?.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });

    // budget_tokens must be camelCased to budgetTokens with min/max preserved.
    expect(capabilities?.reasoningOptions).toEqual([
      { type: 'toggle' },
      { type: 'budgetTokens', min: -1, max: 32_000 },
    ]);

    const cost = metadata.cost;
    expect(cost?.input).toBe(3);
    expect(cost?.output).toBe(15);
    expect(cost?.cacheRead).toBe(0.3);
    expect(cost?.inputAudio).toBe(5);
    expect(cost?.tiers).toEqual([{ tier: { type: 'context', size: 200_000 }, input: 6, output: 30, cacheRead: 0.6 }]);
  });

  it('omits absent optional fields rather than emitting undefined', () => {
    const model = baseModel();
    delete model.temperature;
    delete model.reasoning_options;
    delete model.knowledge;
    delete model.limit.input;
    const metadata = catalogModelToMetadata(model);

    expect('temperature' in (metadata.capabilities ?? {})).toBe(false);
    expect('reasoningOptions' in (metadata.capabilities ?? {})).toBe(false);
    expect('knowledge' in (metadata.capabilities ?? {})).toBe(false);
    expect('input' in (metadata.limit ?? {})).toBe(false);
    // cache_write / reasoning / output_audio never provided -> omitted.
    expect('cacheWrite' in (metadata.cost ?? {})).toBe(false);
    expect('outputAudio' in (metadata.cost ?? {})).toBe(false);
  });

  it('omits cost entirely when the model has no published pricing', () => {
    const model = baseModel();
    delete model.cost;
    const metadata = catalogModelToMetadata(model);

    expect('cost' in metadata).toBe(false);
  });

  it('prefers explicit tiers over the legacy context_over_200k block', () => {
    const model = baseModel();
    model.cost = {
      input: 3,
      output: 15,
      context_over_200k: { input: 6, output: 30 },
      tiers: [{ tier: { type: 'context', size: 128_000 }, input: 4, output: 20, cache_write: 1.5 }],
    };
    const metadata = catalogModelToMetadata(model);

    expect(metadata.cost?.tiers).toEqual([
      { tier: { type: 'context', size: 128_000 }, input: 4, output: 20, cacheWrite: 1.5 },
    ]);
  });
});
