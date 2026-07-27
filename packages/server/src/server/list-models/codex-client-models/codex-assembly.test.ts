import { expect, test } from 'bun:test';

import type { ModelsDevModel } from '@aio-proxy/core';

import { assembleCodexModel } from './codex-assembly';

const model = (overrides: Partial<ModelsDevModel>): ModelsDevModel => ({
  attachment: false,
  description: '',
  id: 'm',
  last_updated: '2026-01-15',
  limit: { context: 128_000, output: 8_000 },
  modalities: { input: ['text'], output: ['text'] },
  name: 'M',
  open_weights: false,
  reasoning: false,
  release_date: '2026-01-15',
  tool_call: false,
  ...overrides,
});

test('synthesized entry substitutes model name and omits availability_nux', () => {
  const entry = assembleCodexModel({ slug: 'my-alias', displayName: 'My Alias', metadata: undefined });
  expect(entry.slug).toBe('my-alias');
  expect(entry.id).toBe('my-alias');
  expect(entry.display_name).toBe('My Alias');
  expect((entry.base_instructions as string).includes('based on my-alias.')).toBe(true);
  expect((entry.base_instructions as string).includes('{{model_name}}')).toBe(false);
  expect((entry.model_messages as { instructions_template: string }).instructions_template).toBe(
    entry.base_instructions,
  );
  expect('availability_nux' in entry).toBe(false);
  // CodexModelBaseSchema requires these; a synthesized entry must carry them.
  expect(entry.priority).toBe(999);
  expect(entry.supported_in_api).toBe(true);
  expect(entry.visibility).toBe('list');
  // No models-dev metadata -> scaffold default modalities include image and the
  // full reasoning list (unknown, assume all).
  expect(entry.input_modalities).toEqual(['text', 'image']);
  expect((entry.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort)).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  expect(entry.default_reasoning_level).toBe('low');
});

test('reasoning levels derive from the models-dev effort option values', () => {
  const entry = assembleCodexModel({
    slug: 'm',
    displayName: 'M',
    metadata: model({
      limit: { context: 128_000, input: 500, output: 8_000 },
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'medium'] }],
      description: 'A synthesized model description',
    }),
  });
  expect((entry.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort)).toEqual(['low', 'medium']);
  expect(entry.default_reasoning_level).toBe('low');
  expect(entry.context_window).toBe(500);
  expect(entry.input_modalities).toEqual(['text']);
  // models.dev description is passed through to a synthesized entry.
  expect(entry.description).toBe('A synthesized model description');
});

test('a non-reasoning model advertises no reasoning levels and no default', () => {
  const entry = assembleCodexModel({
    slug: 'm',
    displayName: 'M',
    metadata: model({
      reasoning: false,
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    }),
  });
  expect(entry.supported_reasoning_levels).toEqual([]);
  expect(entry).not.toHaveProperty('default_reasoning_level');
  // Codex's InputModality enum has no 'pdf'; a pdf-capable model must not leak it.
  expect(entry.input_modalities).toEqual(['text', 'image']);
});

test('an effort option missing its values does not crash and yields no levels', () => {
  const entry = assembleCodexModel({
    slug: 'm',
    displayName: 'M',
    metadata: model({
      reasoning: true,
      // Upstream JSON can omit `values` even though the type marks it required.
      reasoning_options: [{ type: 'effort' } as unknown as { type: 'effort'; values: [] }],
    }),
  });
  expect(entry.supported_reasoning_levels).toEqual([]);
  expect(entry).not.toHaveProperty('default_reasoning_level');
});
