import { afterEach, beforeEach, expect, test } from 'bun:test';

import { CODEX_CLIENT_VERSION, DEFAULT_CHATGPT_USER_AGENT } from '../codex-client';
import {
  CODEX_VERSION_FRESH_MS,
  CODEX_VERSION_RETRY_MS,
  latestCodexRsVersion,
  resetLatestCodexRsVersionCache,
} from './codex-version';
import { chatGPTPluginOptions, englishPluginOptionsText, resolveChatGPTRequestIdentity } from './plugin-options';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  resetLatestCodexRsVersionCache();
});

afterEach(() => {
  resetLatestCodexRsVersionCache();
  globalThis.fetch = originalFetch;
});

test('defaults a blank user agent to the Codex template and rejects a header-invalid value', async () => {
  const options = chatGPTPluginOptions(englishPluginOptionsText);

  await expect(options.schema.parseAsync({})).resolves.toEqual({
    userAgent: DEFAULT_CHATGPT_USER_AGENT,
    userAgentPolicy: 'fixed',
  });
  await expect(options.schema.parseAsync({ userAgent: '   ' })).resolves.toMatchObject({
    userAgent: DEFAULT_CHATGPT_USER_AGENT,
  });
  await expect(options.schema.parseAsync({ userAgent: 'bad\nagent' })).rejects.toThrow();
  expect(options.form.map((field) => field.key)).toEqual(['userAgent', 'userAgentPolicy']);
});

test('fills the latest Codex release into the user agent and catalog client version', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ tag_name: 'rust-v9.9.9' });
  }) as typeof fetch;

  const first = await resolveChatGPTRequestIdentity(undefined, null, fetchImpl);
  const second = await resolveChatGPTRequestIdentity({ userAgent: DEFAULT_CHATGPT_USER_AGENT }, 'curl/8.0', fetchImpl);

  expect(first).toEqual({
    userAgent: DEFAULT_CHATGPT_USER_AGENT.replaceAll('{latest_codex_rs_version}', '9.9.9'),
    clientVersion: '9.9.9',
  });
  expect(second).toEqual(first);
  expect(calls).toBe(1);
});

test('leaves a user agent without the token on the pinned catalog version', async () => {
  await expect(
    resolveChatGPTRequestIdentity(
      { userAgent: 'custom-agent', userAgentPolicy: 'preserveCodexClient' },
      'Codex Desktop/0.155.0',
    ),
  ).resolves.toEqual({ userAgent: 'Codex Desktop/0.155.0', clientVersion: CODEX_CLIENT_VERSION });
  await expect(
    resolveChatGPTRequestIdentity({ userAgent: 'custom-agent', userAgentPolicy: 'fixed' }, 'codex-tui/1'),
  ).resolves.toEqual({ userAgent: 'custom-agent', clientVersion: CODEX_CLIENT_VERSION });
});

test('does not treat a doubled mustache as the Codex version token', async () => {
  await expect(
    resolveChatGPTRequestIdentity({ userAgent: 'codex-tui/{{latest_codex_rs_version}}' }, null),
  ).resolves.toEqual({
    userAgent: 'codex-tui/{{latest_codex_rs_version}}',
    clientVersion: CODEX_CLIENT_VERSION,
  });
});

test('reuses a cached Codex release and falls back to the pin when lookup fails', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) return Response.json({ tag_name: 'rust-v1.2.3' });
    return new Response('nope', { status: 500 });
  }) as typeof fetch;

  await expect(latestCodexRsVersion(fetchImpl, 0)).resolves.toBe('1.2.3');
  await expect(latestCodexRsVersion(fetchImpl, CODEX_VERSION_FRESH_MS - 1)).resolves.toBe('1.2.3');
  expect(calls).toBe(1);
  await expect(latestCodexRsVersion(fetchImpl, CODEX_VERSION_FRESH_MS)).resolves.toBe('1.2.3');
  expect(calls).toBe(2);
  await expect(latestCodexRsVersion(fetchImpl, CODEX_VERSION_FRESH_MS + 1)).resolves.toBe('1.2.3');
  expect(calls).toBe(2);

  resetLatestCodexRsVersionCache();
  let failures = 0;
  const failing = (async () => {
    failures += 1;
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  await expect(latestCodexRsVersion(failing, 0)).resolves.toBe(CODEX_CLIENT_VERSION);
  await expect(latestCodexRsVersion(failing, CODEX_VERSION_RETRY_MS - 1)).resolves.toBe(CODEX_CLIENT_VERSION);
  expect(failures).toBe(1);
  await expect(latestCodexRsVersion(failing, CODEX_VERSION_RETRY_MS)).resolves.toBe(CODEX_CLIENT_VERSION);
  expect(failures).toBe(2);
});
