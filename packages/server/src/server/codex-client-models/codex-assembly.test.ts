import { expect, test } from 'bun:test';

import { assembleCodexModel } from './codex-assembly';

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
    metadata: {
      maxInputTokens: 500,
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'medium'] }],
      modalities: { input: ['text'], output: ['text'] },
    },
  });
  expect((entry.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort)).toEqual(['low', 'medium']);
  expect(entry.default_reasoning_level).toBe('low');
  expect(entry.context_window).toBe(500);
  expect(entry.input_modalities).toEqual(['text']);
});

test('a non-reasoning model advertises no reasoning levels and no default', () => {
  const entry = assembleCodexModel({
    slug: 'm',
    displayName: 'M',
    metadata: {
      reasoning: false,
      modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
    },
  });
  expect(entry.supported_reasoning_levels).toEqual([]);
  expect(entry.default_reasoning_level).toBe('');
  expect(entry.input_modalities).toEqual(['text', 'image', 'pdf']);
});
