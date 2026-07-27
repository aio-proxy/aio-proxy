import { expect, test } from 'bun:test';

import { CodexLeanModelSchema, CodexUpstreamModelSchema } from './codex-model';

test('upstream schema keeps unknown fields via loose', () => {
  const parsed = CodexUpstreamModelSchema.parse({
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    priority: 1,
    supported_in_api: true,
    visibility: 'list',
    base_instructions: 'long text',
    some_new_upstream_field: 42,
  });
  expect(parsed.slug).toBe('gpt-5.6-sol');
  expect((parsed as Record<string, unknown>).some_new_upstream_field).toBe(42);
});

test('lean schema drops rich fields', () => {
  const lean = CodexLeanModelSchema.parse({
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    priority: 1,
    supported_in_api: true,
    visibility: 'list',
    base_instructions: 'dropped',
  });
  expect(Object.keys(lean).sort()).toEqual(
    ['display_name', 'priority', 'slug', 'supported_in_api', 'visibility'].sort(),
  );
});
