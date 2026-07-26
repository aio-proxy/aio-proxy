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
  // No models-dev metadata -> scaffold default modalities include image.
  expect(entry.input_modalities).toEqual(['text', 'image']);
});

test('effort.supported with no per-level flag falls back to the full level list', () => {
  const entry = assembleCodexModel({
    slug: 'm',
    displayName: 'M',
    metadata: {
      capabilities: {
        effort: {
          low: { supported: false },
          medium: { supported: false },
          high: { supported: false },
          xhigh: { supported: false },
          max: { supported: false },
          supported: true,
        },
        image_input: { supported: false },
        pdf_input: { supported: false },
        structured_outputs: { supported: false },
        thinking: { supported: false, types: { adaptive: { supported: false }, enabled: { supported: false } } },
      },
    },
  });
  const levels = (entry.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort);
  expect(levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  expect(levels).toContain(entry.default_reasoning_level as string);
});

test('reasoning levels derive from models-dev effort capabilities', () => {
  const entry = assembleCodexModel({
    slug: 'm',
    displayName: 'M',
    metadata: {
      maxInputTokens: 500,
      capabilities: {
        effort: {
          low: { supported: true },
          medium: { supported: true },
          high: { supported: false },
          xhigh: { supported: false },
          max: { supported: false },
          supported: true,
        },
        image_input: { supported: false },
        pdf_input: { supported: false },
        structured_outputs: { supported: false },
        thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
      },
    },
  });
  expect((entry.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort)).toEqual(['low', 'medium']);
  expect(entry.context_window).toBe(500);
  expect(entry.input_modalities).toEqual(['text']);
});
