import { expect, test } from 'bun:test';

import packageJson from '../../../../package.json' with { type: 'json' };
import { fetchCodexCatalog } from './index';

const input = {
  endpoint: 'https://proxy.example/prefix///',
  token: 'selected-token',
  signal: new AbortController().signal,
};
const row = {
  slug: 'model',
  display_name: 'Model',
  priority: 1,
  supported_in_api: true,
  visibility: 'list',
  base_instructions: '',
  model_messages: { instructions_template: 'FULL', future: ['extra message'] },
  future: { data: true },
};
test('requests the full catalog with CLI version and header-only selected token while retaining unknown messages', async () => {
  const fetchImpl = (async (url: unknown, init: RequestInit | undefined) => {
    expect(String(url)).toBe(
      `https://proxy.example/prefix/v1/models?client_version=${packageJson.version}&codex_instructions=full`,
    );
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer selected-token');
    expect(init?.signal).toBe(input.signal);
    return Response.json({ models: [row] });
  }) as typeof fetch;
  expect(await fetchCodexCatalog(input, fetchImpl)).toEqual({ models: [row] });
});
for (const [name, value] of [
  ['missing slug', { ...row, slug: undefined }],
  ['missing display name', { ...row, display_name: undefined }],
  ['invalid priority', { ...row, priority: 'high' }],
  ['invalid API support', { ...row, supported_in_api: 1 }],
  ['missing visibility', { ...row, visibility: undefined }],
  ['missing base', { ...row, base_instructions: undefined }],
  ['invalid base', { ...row, base_instructions: null }],
  ['invalid messages', { ...row, model_messages: [] }],
  ['invalid template', { ...row, model_messages: { instructions_template: 42 } }],
] as const) {
  test(`rejects the whole catalog for ${name}`, async () => {
    await expect(
      fetchCodexCatalog(input, (async () => Response.json({ models: [row, value] })) as typeof fetch),
    ).rejects.toThrow();
  });
}
test('accepts absent or null optional messages, base-only rows and valid empty models', async () => {
  for (const models of [
    [],
    [{ ...row, model_messages: undefined, base_instructions: 'BASE' }],
    [{ ...row, model_messages: null, base_instructions: 'BASE' }],
    [{ ...row, model_messages: { future: true }, base_instructions: 'BASE' }],
  ]) {
    const expected = JSON.parse(JSON.stringify({ models }));
    expect(await fetchCodexCatalog(input, (async () => Response.json({ models })) as typeof fetch)).toEqual(expected);
  }
});

test('full fetch accepts a valid response above one MiB without applying the compact client limit', async () => {
  const large = {
    models: [{ ...row, model_messages: { instructions_template: 'x'.repeat(1048577), future: ['complete'] } }],
  };
  expect(await fetchCodexCatalog(input, (async () => Response.json(large)) as typeof fetch)).toEqual(large);
});
