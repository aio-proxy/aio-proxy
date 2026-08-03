import { describe, expect, test } from 'bun:test';

import { collectUnknownModelMetadataKeys, ModelMetadataSchema } from './model-metadata';

describe('ModelMetadataSchema validation', () => {
  test('accepts an allowlisted metadata record with name, description, limit, capabilities and cost', () => {
    const parsed = ModelMetadataSchema.parse({
      name: 'GPT-5 Codex',
      description: 'A reasoning-capable coding model.',
      extend: 'openai/gpt-5',
      limit: { context: 1_000_000, output: 128_000 },
      capabilities: {
        reasoning: true,
        temperature: true,
        toolCall: true,
        attachment: true,
        structuredOutput: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        knowledge: '2025-01',
        releaseDate: '2025-06',
        lastUpdated: '2025-07',
      },
      cost: {
        input: 2,
        output: 10,
        image: 0.01,
        request: 0.004,
        tiers: [{ tier: { type: 'context', size: 200_000 }, input: 3 }],
      },
    });
    expect(parsed.name).toBe('GPT-5 Codex');
    expect(parsed.limit?.context).toBe(1_000_000);
    expect(parsed.cost?.tiers?.[0]?.tier.size).toBe(200_000);
  });

  test('round-trips reasoningOptions in the models.dev shape (toggle / effort / budgetTokens)', () => {
    const parsed = ModelMetadataSchema.parse({
      capabilities: {
        reasoningOptions: [
          { type: 'toggle' },
          { type: 'effort', values: ['low', 'medium', 'high', 'xhigh'] },
          { type: 'budgetTokens', min: 1024, max: 32_000 },
        ],
      },
    });
    const options = parsed.capabilities?.reasoningOptions ?? [];
    expect(options).toHaveLength(3);
    const effort = options.find((option) => option.type === 'effort');
    expect(effort?.type === 'effort' && effort.values).toEqual(['low', 'medium', 'high', 'xhigh']);
    const budget = options.find((option) => option.type === 'budgetTokens');
    expect(budget?.type === 'budgetTokens' && budget.max).toBe(32_000);
  });

  test('accepts an effort reasoning option whose value is null (reasoning can be disabled)', () => {
    const parsed = ModelMetadataSchema.parse({
      capabilities: { reasoningOptions: [{ type: 'effort', values: [null, 'high'] }] },
    });
    const option = parsed.capabilities?.reasoningOptions?.[0];
    expect(option?.type === 'effort' && option.values).toEqual([null, 'high']);
  });

  test('rejects an unknown reasoning option discriminator', () => {
    expect(ModelMetadataSchema.safeParse({ capabilities: { reasoningOptions: [{ type: 'mystery' }] } }).success).toBe(
      false,
    );
  });

  test('preserves unknown keys instead of rejecting them (forward compatibility)', () => {
    const parsed = ModelMetadataSchema.parse({ name: 'GPT-5', futureField: true });
    expect(parsed.name).toBe('GPT-5');
    expect((parsed as Record<string, unknown>)['futureField']).toBe(true);
  });

  test('rejects a negative cost as an invalid value', () => {
    expect(ModelMetadataSchema.safeParse({ cost: { input: -1 } }).success).toBe(false);
  });

  test('rejects a non-integer context limit', () => {
    expect(ModelMetadataSchema.safeParse({ limit: { context: 1.5 } }).success).toBe(false);
  });

  test('rejects a non-positive context limit', () => {
    expect(ModelMetadataSchema.safeParse({ limit: { context: 0 } }).success).toBe(false);
  });

  test('rejects a negative tier size', () => {
    expect(
      ModelMetadataSchema.safeParse({ cost: { tiers: [{ tier: { type: 'context', size: -1 }, input: 2 }] } }).success,
    ).toBe(false);
  });
});

describe('collectUnknownModelMetadataKeys', () => {
  test('returns nothing when every key is allowlisted', () => {
    const metadata = { 'up-a': ModelMetadataSchema.parse({ limit: { context: 128_000 }, cost: { input: 2 } }) };
    expect(collectUnknownModelMetadataKeys(metadata)).toEqual([]);
  });

  test('reports unknown top-level and nested cost keys with their model-id path', () => {
    const metadata = {
      'up-a': ModelMetadataSchema.parse({ limit: { context: 128_000 }, mystery: 1, cost: { input: 2, surcharge: 9 } }),
    };
    expect(collectUnknownModelMetadataKeys(metadata)).toEqual(['up-a.mystery', 'up-a.cost.surcharge']);
  });
});
