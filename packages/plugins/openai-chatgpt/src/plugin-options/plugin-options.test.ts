import { afterEach, beforeEach, expect, test } from 'bun:test';

import { CODEX_CLIENT_VERSION, DEFAULT_CHATGPT_USER_AGENT } from '../codex-client';
import {
  CODEX_VERSION_FRESH_MS,
  CODEX_VERSION_RETRY_MS,
  latestCodexRsVersion,
  resetLatestCodexRsVersionCache,
} from './codex-version';
import { chatGPTPluginOptions, englishPluginOptionsText, resolveChatGPTRequestIdentity } from './plugin-options';

beforeEach(() => {
  resetLatestCodexRsVersionCache();
});

afterEach(() => {
  resetLatestCodexRsVersionCache();
});

test('defaults a blank user agent to the Codex template and rejects a header-invalid value', async () => {
  const options = chatGPTPluginOptions(englishPluginOptionsText);

  await expect(options.schema.parseAsync({})).resolves.toEqual({
    userAgent: DEFAULT_CHATGPT_USER_AGENT,
    userAgentPolicy: 'fixed',
    guardianStrategy: 'default',
  });
  await expect(options.schema.parseAsync({ userAgent: '   ' })).resolves.toMatchObject({
    userAgent: DEFAULT_CHATGPT_USER_AGENT,
  });
  await expect(options.schema.parseAsync({ userAgent: 'bad\nagent' })).rejects.toThrow();
  expect(options.form.map((field) => field.key)).toEqual([
    'userAgent',
    'userAgentPolicy',
    'guardianStrategy',
    'guardianProviderId',
    'guardianModelId',
  ]);
});

test.each(['systemOne', 'systemOneReviewDenied'] as const)(
  '%s requires an evaluation Provider and model',
  async (guardianStrategy) => {
    const spec = chatGPTPluginOptions(englishPluginOptionsText);
    await expect(
      spec.schema.parseAsync({ guardianStrategy, guardianProviderId: ' p ', guardianModelId: ' m ' }),
    ).resolves.toMatchObject({ guardianStrategy, guardianProviderId: 'p', guardianModelId: 'm' });
    for (const missing of [
      {},
      { guardianProviderId: 'p' },
      { guardianModelId: 'm' },
      { guardianProviderId: '  ', guardianModelId: 'm' },
      { guardianProviderId: 'p', guardianModelId: '  ' },
    ]) {
      await expect(spec.schema.parseAsync({ guardianStrategy, ...missing })).rejects.toThrow();
    }
  },
);

test('default strategy retains a saved target but does not require one', async () => {
  const spec = chatGPTPluginOptions(englishPluginOptionsText);
  await expect(
    spec.schema.parseAsync({ guardianStrategy: 'default', guardianProviderId: 'p', guardianModelId: 'm' }),
  ).resolves.toMatchObject({ guardianStrategy: 'default', guardianProviderId: 'p', guardianModelId: 'm' });
  const [strategy, provider, model] = spec.form.slice(2);
  expect(strategy).toMatchObject({ type: 'select', key: 'guardianStrategy', defaultValue: 'default' });
  expect(provider).toMatchObject({
    type: 'provider',
    key: 'guardianProviderId',
    protocols: ['typesafe-systemone'],
    when: { key: 'guardianStrategy', notEquals: 'default' },
  });
  expect(model).toMatchObject({
    type: 'provider-model',
    key: 'guardianModelId',
    providerKey: 'guardianProviderId',
    when: { key: 'guardianStrategy', notEquals: 'default' },
  });
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
    userAgent: DEFAULT_CHATGPT_USER_AGENT.replaceAll('{{latest_codex_rs_version}}', '9.9.9'),
    clientVersion: '9.9.9',
  });
  expect(second).toEqual(first);
  expect(calls).toBe(2);
});

test('leaves a user agent without the token on the pinned catalog version', async () => {
  let lookups = 0;
  const fetchImpl = (async () => {
    lookups++;
    throw new Error('version lookup is unnecessary');
  }) as typeof fetch;
  await expect(
    resolveChatGPTRequestIdentity(
      { userAgent: 'custom-agent', userAgentPolicy: 'preserveCodexClient' },
      'Codex Desktop/0.155.0',
      fetchImpl,
    ),
  ).resolves.toEqual({ userAgent: 'Codex Desktop/0.155.0', clientVersion: CODEX_CLIENT_VERSION });
  await expect(
    resolveChatGPTRequestIdentity({ userAgent: 'custom-agent', userAgentPolicy: 'fixed' }, 'codex-tui/1', fetchImpl),
  ).resolves.toEqual({ userAgent: 'custom-agent', clientVersion: CODEX_CLIENT_VERSION });
  expect(lookups).toBe(0);
});

test('resolves repeated Handlebars version tokens with optional whitespace', async () => {
  await expect(
    resolveChatGPTRequestIdentity(
      { userAgent: 'codex-tui/{{ latest_codex_rs_version }} ({{latest_codex_rs_version}})' },
      null,
      (async () => Response.json({ tag_name: 'rust-v9.9.9', version: '9.9.9' })) as typeof fetch,
    ),
  ).resolves.toEqual({
    userAgent: 'codex-tui/9.9.9 (9.9.9)',
    clientVersion: '9.9.9',
  });
});

test.each(['{{unknown}}', '{{{latest_codex_rs_version}}}', '{{#if latest_codex_rs_version}}yes{{/if}}'])(
  'rejects unsupported user agent templates: %s',
  async (userAgent) => {
    await expect(chatGPTPluginOptions(englishPluginOptionsText).schema.parseAsync({ userAgent })).rejects.toThrow();
  },
);

test('a fast failed source does not hide a valid npm release', async () => {
  const fetchImpl = (async (input: RequestInfo | URL) =>
    String(input).includes('registry.npmjs.org')
      ? Response.json({ name: '@openai/codex', version: '9.9.9' })
      : new Response('unavailable', { status: 503 })) as typeof fetch;
  await expect(latestCodexRsVersion(fetchImpl)).resolves.toBe('9.9.9');
});

test.each(['9.9.9-alpha.1', '9.9.9\r\nInjected: value', 'not-a-version'])(
  'ignores non-stable or malformed versions from both sources: %s',
  async (version) => {
    const fetchImpl = (async () =>
      Response.json({ name: '@openai/codex', version, tag_name: `rust-v${version}` })) as typeof fetch;
    await expect(latestCodexRsVersion(fetchImpl)).resolves.toBe(CODEX_CLIENT_VERSION);
  },
);

test('concurrent requests share one pair of release lookups', async () => {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl = (async () => {
    calls++;
    await gate;
    return Response.json({ name: '@openai/codex', version: '9.9.9', tag_name: 'rust-v9.9.9' });
  }) as typeof fetch;
  const requests = [latestCodexRsVersion(fetchImpl), latestCodexRsVersion(fetchImpl), latestCodexRsVersion(fetchImpl)];
  release();
  expect(await Promise.all(requests)).toEqual(['9.9.9', '9.9.9', '9.9.9']);
  expect(calls).toBe(2);
});

test('returns the first valid source, then upgrades the cache when the slower source is newer', async () => {
  let release!: (response: Response) => void;
  const github = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetchImpl = (async (input: RequestInfo | URL) =>
    String(input).includes('api.github.com')
      ? github
      : Response.json({ name: '@openai/codex', version: '9.9.9' })) as typeof fetch;
  const pending = latestCodexRsVersion(fetchImpl);
  const first = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 50))]);
  release(Response.json({ tag_name: 'rust-v9.10.0' }));
  await pending;
  // Flush the slower response's JSON parse and cache update.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(first).toBe('9.9.9');
  await expect(latestCodexRsVersion(fetchImpl)).resolves.toBe('9.10.0');
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
  expect(calls).toBe(2);
  await expect(latestCodexRsVersion(fetchImpl, CODEX_VERSION_FRESH_MS)).resolves.toBe('1.2.3');
  expect(calls).toBe(4);
  await expect(latestCodexRsVersion(fetchImpl, CODEX_VERSION_FRESH_MS + 1)).resolves.toBe('1.2.3');
  expect(calls).toBe(4);

  resetLatestCodexRsVersionCache();
  let failures = 0;
  const failing = (async () => {
    failures += 1;
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  await expect(latestCodexRsVersion(failing, 0)).resolves.toBe(CODEX_CLIENT_VERSION);
  await expect(latestCodexRsVersion(failing, CODEX_VERSION_RETRY_MS - 1)).resolves.toBe(CODEX_CLIENT_VERSION);
  expect(failures).toBe(2);
  await expect(latestCodexRsVersion(failing, CODEX_VERSION_RETRY_MS)).resolves.toBe(CODEX_CLIENT_VERSION);
  expect(failures).toBe(4);
});
