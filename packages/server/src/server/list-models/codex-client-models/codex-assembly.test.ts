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

const TEMPLATE = {
  slug: 'gpt-5.5',
  display_name: 'GPT-5.5',
  priority: 7,
  supported_in_api: true,
  visibility: 'list',
  shell_type: 'shell_command',
  truncation_policy: { mode: 'tokens', limit: 10_000 },
  support_verbosity: true,
  default_verbosity: 'low',
  supports_parallel_tool_calls: true,
  experimental_supported_tools: [],
  apply_patch_tool_type: 'freeform',
  availability_nux: { message: 'promo' },
  upgrade: { model: 'gpt-6', migration_markdown: 'x' },
  default_reasoning_level: 'medium',
};

test('synthesized entry inherits required ModelInfo fields from the template and drops promo fields', () => {
  const entry = assembleCodexModel({ slug: 'x', displayName: 'X', metadata: undefined, template: TEMPLATE });
  // Required (non-Option, no serde default) Codex ModelInfo fields must be present
  // or the client rejects the whole Vec<ModelInfo> and shows an empty picker.
  expect(entry.shell_type).toBe('shell_command');
  expect(entry.truncation_policy).toEqual({ mode: 'tokens', limit: 10_000 });
  expect(entry.support_verbosity).toBe(true);
  expect(entry.supports_parallel_tool_calls).toBe(true);
  expect(entry.experimental_supported_tools).toEqual([]);
  // Model-specific promo/routing fields must not leak from the template.
  expect('availability_nux' in entry).toBe(false);
  expect('upgrade' in entry).toBe(false);
  // A synthesized model overrides identity and priority regardless of template.
  expect(entry.slug).toBe('x');
  expect(entry.priority).toBe(999);
});

test('synthesized entry carries required fields even with no template (offline)', () => {
  const entry = assembleCodexModel({ slug: 'x', displayName: 'X', metadata: undefined, template: undefined });
  expect(entry.shell_type).toBe('shell_command');
  expect(entry.truncation_policy).toEqual({ mode: 'tokens', limit: 10_000 });
  expect(entry.support_verbosity).toBe(true);
  expect(entry.supports_parallel_tool_calls).toBe(true);
  expect(entry.experimental_supported_tools).toEqual([]);
});

test('synthesized entry substitutes model name and omits availability_nux', () => {
  const entry = assembleCodexModel({
    slug: 'my-alias',
    displayName: 'My Alias',
    metadata: undefined,
    template: undefined,
  });
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
    template: undefined,
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
    template: undefined,
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
    template: undefined,
  });
  expect(entry.supported_reasoning_levels).toEqual([]);
  expect(entry).not.toHaveProperty('default_reasoning_level');
});
