import { expect, test } from 'bun:test';

import { inspectTomlPaths } from '../../toml-document';
import { configureGrokToml, equalGrokLeaf, readGrokLeaf, restoreGrokToml } from './toml';

const ENDPOINT = 'http://127.0.0.1:9317';
const COMMAND = "'/opt/bin/aio-proxy' agent auth grok --installation-id x";
const MODELS_DEFAULT = '[models]\ndefault = "keep-me"\n';
const MODELS_DEFAULT_CRLF = '[models]\r\ndefault = "keep-me"\r\n';

test('restores owned leaves but preserves later user edits and comments', () => {
  const input = '# mine\n[auth]\nauth_provider_label = \'Cloud\' # label\n[ui]\ntheme = "dark"\n';
  const first = configureGrokToml(
    input,
    'http://127.0.0.1:9317',
    "'/opt/bin/aio-proxy' agent auth grok --installation-id x",
  );
  expect(first.text).toContain('# mine\n');
  expect(first.text).toContain('# label');
  expect(first.text).toContain('[ui]\ntheme = "dark"\n');
  const edited = first.text.replace('"AIO Proxy"', '"Personal"');
  const restored = restoreGrokToml(edited, first.leaves, first.createdTables);
  expect(restored.text).toContain('auth_provider_label = "Personal"');
  expect(restored.text).not.toContain('models_base_url');
  expect(restored.skipped).toContain('auth.auth_provider_label');
  expect(restored.text).toContain('[ui]\ntheme = "dark"');
});

test('rejects ambiguous catalog aliases before producing a patch', () => {
  const text = '[endpoints]\nmodels_list_url="one"\nmodels_endpoint="two"\n';
  expect(() => configureGrokToml(text, 'http://127.0.0.1:9317', 'command')).toThrow(/alias/);
});

type Parsed = {
  endpoints?: Record<string, unknown>;
  auth?: Record<string, unknown>;
  grok_com_config?: Record<string, unknown>;
  models?: { default?: string };
};

const parse = (text: string): Parsed => Bun.TOML.parse(text) as Parsed;

const expectDesiredEndpoints = (
  parsed: Parsed,
  endpoint: string,
  catalogKey: 'models_list_url' | 'models_endpoint' = 'models_list_url',
) => {
  expect(parsed.endpoints?.models_base_url).toBe(`${endpoint}/v1`);
  expect(parsed.endpoints?.[catalogKey]).toBe(`${endpoint}/v1/models`);
  expect(parsed.endpoints?.cli_chat_proxy_base_url).toBe(endpoint);
  expect(parsed.endpoints?.xai_api_base_url).toBe(`${endpoint}/v1`);
  expect(parsed.endpoints?.managed_config_url).toBe(`${endpoint}/__grok_unavailable/managed-config`);
  if (catalogKey === 'models_endpoint') expect(parsed.endpoints?.models_list_url).toBeUndefined();
};

test.each([
  {
    name: 'empty document',
    input: '',
    preserved: [] as string[],
    modelsSnippet: undefined as string | undefined,
  },
  {
    name: 'LF document with models.default',
    input: `${MODELS_DEFAULT}[ui]\ntheme = "dark"\n`,
    preserved: ['[ui]\ntheme = "dark"\n'],
    modelsSnippet: MODELS_DEFAULT,
  },
  {
    name: 'CRLF document',
    input: `${MODELS_DEFAULT_CRLF}[ui]\r\ntheme = "dark"\r\n`,
    preserved: ['[ui]\r\ntheme = "dark"\r\n'],
    modelsSnippet: MODELS_DEFAULT_CRLF,
  },
  {
    name: 'quoted dotted table',
    input: `["user.section"]\nnote = "keep"\n${MODELS_DEFAULT}`,
    preserved: ['["user.section"]\nnote = "keep"'],
    modelsSnippet: MODELS_DEFAULT,
  },
  {
    name: 'quoted managed key',
    input: `[endpoints]\n"models_base_url" = "old"\nkeep = "yes"\n${MODELS_DEFAULT}`,
    preserved: ['keep = "yes"'],
    modelsSnippet: MODELS_DEFAULT,
  },
  {
    name: 'implicit dotted endpoints table',
    input: `endpoints.keep = "x"\n${MODELS_DEFAULT}`,
    preserved: ['endpoints.keep = "x"'],
    modelsSnippet: MODELS_DEFAULT,
    implicitEndpoints: true,
  },
  {
    name: 'inline endpoints table',
    input: `endpoints={models_base_url="old",other=1}\n${MODELS_DEFAULT}`,
    preserved: ['other=1'],
    modelsSnippet: MODELS_DEFAULT,
    inlineOther: true,
  },
  {
    name: 'standalone catalog alias',
    input: `[endpoints]\nmodels_endpoint = "https://other/v1/models"\nkeep = "yes"\n${MODELS_DEFAULT}`,
    preserved: ['keep = "yes"'],
    modelsSnippet: MODELS_DEFAULT,
    catalogKey: 'models_endpoint' as const,
  },
  {
    name: 'standalone grok_com_config table',
    input: `[grok_com_config]\nkeep = "yes"\n${MODELS_DEFAULT}`,
    preserved: ['keep = "yes"'],
    modelsSnippet: MODELS_DEFAULT,
    authTable: 'grok_com_config' as const,
    expectNoAuthHeader: true,
  },
  {
    name: 'split auth tables',
    input:
      `[auth]\nauth_provider_command = "old-cmd"\nkeep_auth = "yes"\n` +
      `[grok_com_config]\nauth_provider_label = 'Cloud'\nkeep_grok = "yes"\n${MODELS_DEFAULT}`,
    preserved: ['keep_auth = "yes"', 'keep_grok = "yes"'],
    modelsSnippet: MODELS_DEFAULT,
    splitAuth: true,
  },
])('configures $name while preserving unrelated bytes', (fixture) => {
  const first = configureGrokToml(fixture.input, ENDPOINT, COMMAND);
  for (const fragment of fixture.preserved) expect(first.text).toContain(fragment);
  if (fixture.modelsSnippet !== undefined) expect(first.text).toContain(fixture.modelsSnippet);
  if (fixture.name === 'CRLF document') {
    expect(first.text.includes('\r\n')).toBe(true);
    expect(first.text.includes('\n') && !first.text.includes('\r\n')).toBe(false);
  }
  const parsed = parse(first.text);
  expectDesiredEndpoints(parsed, ENDPOINT, fixture.catalogKey ?? 'models_list_url');
  if (fixture.splitAuth) {
    expect(parsed.auth?.auth_provider_command).toBe(COMMAND);
    expect(parsed.auth?.keep_auth).toBe('yes');
    expect(parsed.auth?.auth_provider_label).toBeUndefined();
    expect(parsed.grok_com_config?.auth_provider_label).toBe('AIO Proxy');
    expect(parsed.grok_com_config?.keep_grok).toBe('yes');
    expect(parsed.grok_com_config?.auth_provider_command).toBeUndefined();
  } else {
    const authTable = fixture.authTable ?? 'auth';
    expect(parsed[authTable]?.auth_provider_command).toBe(COMMAND);
    expect(parsed[authTable]?.auth_provider_label).toBe('AIO Proxy');
  }
  if (fixture.expectNoAuthHeader) {
    expect(first.text).not.toContain('[auth]');
    expect(parsed.auth).toBeUndefined();
  }
  if (fixture.inlineOther) {
    expect(parsed.endpoints?.other).toBe(1);
    expect(first.createdTables).not.toContainEqual(['endpoints']);
  }
  if (fixture.implicitEndpoints) {
    expect(first.text).not.toContain('[endpoints]');
    expect(first.createdTables).not.toContainEqual(['endpoints']);
    expect(parsed.endpoints?.keep).toBe('x');
  }
  if (fixture.name === 'quoted dotted table') {
    expect(inspectTomlPaths(first.text, { tomlVersion: '1.0' }).tablePaths).toContainEqual(['user.section']);
  }
  expect(parsed.models?.default).toBe(fixture.modelsSnippet === undefined ? undefined : 'keep-me');

  const restored = restoreGrokToml(first.text, first.leaves, first.createdTables);
  for (const fragment of fixture.preserved) expect(restored.text).toContain(fragment);
  if (fixture.modelsSnippet !== undefined) expect(restored.text).toContain(fixture.modelsSnippet);
  if (fixture.inlineOther) {
    expect(parse(restored.text).endpoints?.models_base_url).toBe('old');
    expect(parse(restored.text).endpoints?.other).toBe(1);
  }
});

test.each([
  { name: 'invalid TOML', input: '[auth\n', pattern: /invalid toml document/i },
  {
    name: 'array managed value',
    input: `[endpoints]\nmodels_base_url = ["x"]\n${MODELS_DEFAULT}`,
    pattern: /unsupported_managed_value/,
  },
  {
    name: 'numeric managed value',
    input: `[endpoints]\nmodels_base_url = 1\n${MODELS_DEFAULT}`,
    pattern: /unsupported_managed_value/,
  },
  {
    name: 'boolean managed value',
    input: `[endpoints]\nmodels_base_url = true\n${MODELS_DEFAULT}`,
    pattern: /unsupported_managed_value/,
  },
  {
    name: 'table managed value',
    input: `[endpoints.models_base_url]\nnested = "x"\n${MODELS_DEFAULT}`,
    pattern: /unsupported_managed_value/,
  },
  {
    name: 'auth alias conflict',
    input: `[auth]\nauth_provider_label = "a"\n[grok_com_config]\nauth_provider_label = "b"\n${MODELS_DEFAULT}`,
    pattern: /alias/,
  },
])('rejects $name before producing a patch', ({ input, pattern }) => {
  expect(() => configureGrokToml(input, ENDPOINT, COMMAND)).toThrow(pattern);
});

test('readGrokLeaf treats a missing key as absence', () => {
  expect(readGrokLeaf('[ui]\ntheme = "dark"\n', ['auth', 'auth_provider_label'])).toEqual({ present: false });
  expect(
    equalGrokLeaf({ present: true, value: 'Cloud', raw: "'Cloud'" }, { present: true, value: 'Cloud', raw: '"Cloud"' }),
  ).toBe(true);
});

test('restores original quoting when owned leaves are unchanged', () => {
  const input = `${MODELS_DEFAULT}[auth]\nauth_provider_label = 'Cloud'\n`;
  const first = configureGrokToml(input, ENDPOINT, COMMAND);
  const restored = restoreGrokToml(first.text, first.leaves, first.createdTables);
  expect(restored.text).toContain("auth_provider_label = 'Cloud'");
  expect(restored.text).toContain(MODELS_DEFAULT);
  expect(restored.skipped).toEqual([]);
  expect(restored.text).not.toContain('models_base_url');
});

test('keeps a user field added after configure and does not rewrite models.default', () => {
  const first = configureGrokToml(`${MODELS_DEFAULT}[ui]\ntheme = "dark"\n`, ENDPOINT, COMMAND);
  const withUser = first.text.replace('[endpoints]\n', '[endpoints]\nuser_keep = "yes"\n');
  const restored = restoreGrokToml(withUser, first.leaves, first.createdTables);
  expect(restored.text).toContain('user_keep = "yes"');
  expect(restored.text).toContain('[endpoints]');
  expect(restored.text).toContain('[ui]\ntheme = "dark"');
  expect(restored.text).toContain(MODELS_DEFAULT);
  expect(parse(restored.text).endpoints?.user_keep).toBe('yes');
});

test('reconfigure keeps the first original and refuses drifted leaves', () => {
  const input = `${MODELS_DEFAULT}[auth]\nauth_provider_label = 'Cloud'\n`;
  const first = configureGrokToml(input, ENDPOINT, COMMAND);
  const label = first.leaves.find((leaf) => leaf.path[1] === 'auth_provider_label');
  expect(label?.original).toMatchObject({ present: true, value: 'Cloud', raw: "'Cloud'" });
  const nextEndpoint = 'http://127.0.0.1:19000';
  const second = configureGrokToml(first.text, nextEndpoint, COMMAND, {
    leaves: first.leaves,
    createdTables: first.createdTables,
  });
  expect(second.text).toContain(MODELS_DEFAULT);
  expect(second.leaves.find((leaf) => leaf.path[1] === 'auth_provider_label')?.original).toEqual(label?.original);
  expectDesiredEndpoints(parse(second.text), nextEndpoint);
  const drifted = second.text.replace('"AIO Proxy"', '"Mine"');
  expect(() =>
    configureGrokToml(drifted, ENDPOINT, COMMAND, { leaves: second.leaves, createdTables: second.createdTables }),
  ).toThrow(/modified/);
  expect(drifted).toContain('"Mine"');
  expect(drifted).toContain(MODELS_DEFAULT);
  expect(parse(drifted).models?.default).toBe('keep-me');
});

test('skips a deleted owned leaf and restores the rest', () => {
  const first = configureGrokToml(MODELS_DEFAULT, ENDPOINT, COMMAND);
  const removed = first.text.replace(/models_base_url = ".*"\n/, '');
  const restored = restoreGrokToml(removed, first.leaves, first.createdTables);
  expect(restored.skipped).toContain('endpoints.models_base_url');
  expect(restored.text).toContain(MODELS_DEFAULT);
  expect(restored.text).not.toContain('cli_chat_proxy_base_url');
});
