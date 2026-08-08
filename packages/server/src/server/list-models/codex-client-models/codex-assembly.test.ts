import { expect, test } from 'bun:test';

import type { ModelMetadata } from '@aio-proxy/types';

import { assembleCodexModel } from './codex-assembly';

// Merged, config-over-catalog metadata (camelCase ModelMetadata) — the shape
// assembleCodexModel actually consumes, so a config override reaches the entry.
const metadata = (overrides: Partial<ModelMetadata>): ModelMetadata => ({
  name: 'M',
  description: '',
  limit: { context: 128_000, output: 8_000 },
  capabilities: {
    reasoning: false,
    toolCall: false,
    attachment: false,
    modalities: { input: ['text'], output: ['text'] },
  },
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
  const entry = assembleCodexModel({
    slug: 'x',
    displayName: 'X',
    metadata: undefined,
    contextWindow: 272_000,
    maxContextWindow: 272_000,
    template: TEMPLATE,
  });
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
  const entry = assembleCodexModel({
    slug: 'x',
    displayName: 'X',
    metadata: undefined,
    contextWindow: 272_000,
    maxContextWindow: 272_000,
    template: undefined,
  });
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
    contextWindow: 272_000,
    maxContextWindow: 272_000,
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
    contextWindow: 500,
    maxContextWindow: 128_000,
    metadata: metadata({
      limit: { context: 128_000, input: 500, output: 8_000 },
      capabilities: {
        reasoning: true,
        reasoningOptions: [{ type: 'effort', values: ['low', 'medium'] }],
        modalities: { input: ['text'], output: ['text'] },
      },
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
    contextWindow: 128_000,
    maxContextWindow: 128_000,
    metadata: metadata({
      capabilities: {
        reasoning: false,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
      },
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
    contextWindow: 128_000,
    maxContextWindow: 128_000,
    metadata: metadata({
      capabilities: {
        reasoning: true,
        // Upstream JSON can omit `values` even though the type marks it required.
        reasoningOptions: [{ type: 'effort' } as unknown as { type: 'effort'; values: [] }],
        modalities: { input: ['text'], output: ['text'] },
      },
    }),
    template: undefined,
  });
  expect(entry.supported_reasoning_levels).toEqual([]);
  expect(entry).not.toHaveProperty('default_reasoning_level');
});

test('writes distinct default and maximum Codex windows', () => {
  const entry = assembleCodexModel({
    slug: 'm',
    displayName: 'M',
    metadata: undefined,
    contextWindow: 272_000,
    maxContextWindow: 400_000,
    template: undefined,
  });
  expect(entry.context_window).toBe(272_000);
  expect(entry.max_context_window).toBe(400_000);
});

test('config metadata overrides (description, modalities, reasoning) flow into the synthesized entry', () => {
  // effectiveMetadata carries config-over-catalog values: a description, image
  // modality, and an effort option the raw catalog never had. Reading the merged
  // metadata (not the raw catalog) is what surfaces these to Codex.
  const entry = assembleCodexModel({
    slug: 'm',
    displayName: 'M',
    contextWindow: 128_000,
    maxContextWindow: 128_000,
    metadata: metadata({
      description: 'Config-overridden description',
      capabilities: {
        reasoning: true,
        reasoningOptions: [{ type: 'effort', values: ['high', 'max'] }],
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    }),
    template: undefined,
  });
  expect(entry.description).toBe('Config-overridden description');
  expect(entry.input_modalities).toEqual(['text', 'image']);
  expect((entry.supported_reasoning_levels as { effort: string }[]).map((l) => l.effort)).toEqual(['high', 'max']);
});
