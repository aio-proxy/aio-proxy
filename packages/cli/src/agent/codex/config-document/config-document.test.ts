import { expect, test } from 'bun:test';

import {
  codexProviderEdits,
  editCodexDocument,
  readCodexDocument,
  readManagedField,
  validateCodexProviderId,
} from './index';

test('switches Provider without rewriting model, comments or MCP', () => {
  const original =
    '# chosen by user\nmodel = "keep-model"\n' +
    'approval_policy = "never"\n\n[mcp_servers.local]\ncommand = "local-mcp"\n';
  const actual = editCodexDocument(original, codexProviderEdits('proxy.team', 'http://127.0.0.1:9317/v1', 'test-key'));
  const parsed = Bun.TOML.parse(actual);
  expect(parsed.model).toBe('keep-model');
  expect(parsed.model_provider).toBe('proxy.team');
  expect(actual).toContain('# chosen by user\nmodel = "keep-model"');
  expect(actual).toContain('[mcp_servers.local]\ncommand = "local-mcp"');
  expect(parsed.model_providers).toEqual({
    'proxy.team': {
      name: 'aio-proxy',
      base_url: 'http://127.0.0.1:9317/v1',
      wire_api: 'responses',
      requires_openai_auth: true,
      experimental_bearer_token: 'test-key',
    },
  });
  expect(editCodexDocument(actual, codexProviderEdits('proxy.team', 'http://127.0.0.1:9317/v1', 'test-key'))).toBe(
    actual,
  );
});

test('preserves unrelated model provider tables and updates an inline provider', () => {
  const original =
    'model_provider = "old"\n' +
    'model_providers = { other = { name = "keep" }, old = { name = "old" } }\n' +
    '[mcp_servers.local]\ncommand = "mcp"\n';
  const actual = editCodexDocument(original, codexProviderEdits('proxy.team', 'https://proxy/v1', 'tok'));
  const parsed = Bun.TOML.parse(actual);
  expect(parsed.model_providers.other).toEqual({ name: 'keep' });
  expect(parsed.model_providers.old).toEqual({ name: 'old' });
  expect(parsed.model_providers['proxy.team']).toEqual({
    name: 'aio-proxy',
    base_url: 'https://proxy/v1',
    wire_api: 'responses',
    requires_openai_auth: true,
    experimental_bearer_token: 'tok',
  });
  expect(actual).toContain('model_providers = { other = { name = "keep" }, old = { name = "old" },');
});

test('adds missing fields to an existing inline provider in source order', () => {
  const original = 'model_providers = { "proxy.team" = { name = "old" } }\n';
  const actual = editCodexDocument(original, codexProviderEdits('proxy.team', 'url', 'token'));
  expect(Bun.TOML.parse(actual).model_providers['proxy.team']).toEqual({
    name: 'aio-proxy',
    base_url: 'url',
    wire_api: 'responses',
    requires_openai_auth: true,
    experimental_bearer_token: 'token',
  });
  expect(actual).toContain(
    'name = "aio-proxy", base_url = "url", wire_api = "responses", requires_openai_auth = true, experimental_bearer_token = "token"',
  );
});

test('creates a valid document from an empty source', () => {
  const actual = editCodexDocument('', codexProviderEdits('proxy.team', 'url', 'token'));
  expect(Bun.TOML.parse(actual).model_provider).toBe('proxy.team');
  expect(editCodexDocument(actual, codexProviderEdits('proxy.team', 'url', 'token'))).toBe(actual);
});

test('updates an existing quoted and dotted provider table without splitting its id', () => {
  const original =
    'model_provider = "proxy.team"\n\n' +
    '[model_providers."proxy.team"]\n' +
    'name = "old" # preserve this comment\n' +
    'base_url = "old-url"\n' +
    '[mcp_servers.local]\ncommand = "mcp"\n';
  const actual = editCodexDocument(original, codexProviderEdits('proxy.team', 'new-url', 'new-token'));
  expect(actual).toContain('[model_providers."proxy.team"]');
  expect(actual).toContain('name = "aio-proxy" # preserve this comment');
  expect(Bun.TOML.parse(actual).model_providers['proxy.team'].base_url).toBe('new-url');
});

test('preserves comma strings, multiline strings, comments, and CRLF', () => {
  const original =
    '# header\r\nmodel = "keep, model" # model comment\r\n' +
    'description = """line one\r\nline two"""\r\n\r\n' +
    '[model_providers.other]\r\nname = "keep"\r\n';
  const actual = editCodexDocument(original, codexProviderEdits('proxy.team', 'url', 'token,with,commas'));
  expect(actual).toContain('# header\r\nmodel = "keep, model" # model comment\r\n');
  expect(actual).toContain('description = """line one\r\nline two"""\r\n');
  expect(actual).toContain('[model_providers.other]\r\nname = "keep"\r\n');
  expect(actual.includes('\n') && !actual.includes('\r\n')).toBe(false);
  expect(Bun.TOML.parse(actual).model_providers['proxy.team'].experimental_bearer_token).toBe('token,with,commas');
});

test('deletes first, middle, and last inline members while retaining other source text', () => {
  const original =
    'model_providers = { first = { name = "one", remove = true }, keep = { remove = true, name = "two" }, last = { remove = true, name = "three" } }\n';
  const first = editCodexDocument(original, [{ path: ['model_providers', 'first'], next: { present: false } }]);
  const middle = editCodexDocument(original, [
    { path: ['model_providers', 'keep', 'remove'], next: { present: false } },
  ]);
  const last = editCodexDocument(original, [{ path: ['model_providers', 'last'], next: { present: false } }]);
  expect(Bun.TOML.parse(first).model_providers).toEqual({
    keep: { remove: true, name: 'two' },
    last: { remove: true, name: 'three' },
  });
  expect(Bun.TOML.parse(middle).model_providers.keep).toEqual({ name: 'two' });
  expect(Bun.TOML.parse(last).model_providers).toEqual({
    first: { name: 'one', remove: true },
    keep: { remove: true, name: 'two' },
  });
});

test('reports an existing managed field with an unsupported type', () => {
  expect(() => readManagedField('model_provider = ["wrong"]\n', ['model_provider'])).toThrow(
    /managed field.*string or boolean/i,
  );
});

test('rejects duplicate TOML keys and invalid provider IDs', () => {
  expect(() => readCodexDocument('model = "one"\nmodel = "two"\n')).toThrow(/duplicate|multiple times/i);
  expect(() => validateCodexProviderId('   ')).toThrow();
  expect(() => validateCodexProviderId('proxy\nteam')).toThrow();
  expect(() => validateCodexProviderId('openai')).toThrow();
  expect(validateCodexProviderId('  proxy.team  ')).toBe('proxy.team');
});

test('reads absent and present managed fields', () => {
  expect(readManagedField('model_provider = "proxy.team"\n', ['model_provider'])).toEqual({
    present: true,
    value: 'proxy.team',
  });
  expect(readManagedField('', ['model_provider'])).toEqual({ present: false });
  expect(readCodexDocument('model_provider = "proxy.team"\n').activeProviderId).toBe('proxy.team');
});

test('discovers providers from standard, root-table, inline, and dotted assignments', () => {
  expect(readCodexDocument('[model_providers.proxy]\nname = "x"\n').providerIds).toEqual(['proxy']);
  expect(readCodexDocument('model_providers = { proxy = { name = "x" } }\n').providerIds).toEqual(['proxy']);
  expect(readCodexDocument('[model_providers]\nproxy = { name = "x" }\n').providerIds).toEqual(['proxy']);
  expect(readCodexDocument('model_providers.proxy = { name = "x" }\n').providerIds).toEqual(['proxy']);
});

test('deletes standard provider scalar fields while preserving unrelated fields and tables', () => {
  const original =
    '# keep\n[model_providers.proxy]\n' +
    'name = "aio-proxy" # first\n' +
    'base_url = "url"\n' +
    'wire_api = "responses" # middle\n' +
    'requires_openai_auth = true\n' +
    'experimental_bearer_token = "token" # last\n' +
    'custom = "keep"\n\n' +
    '[mcp_servers.local]\ncommand = "mcp"\n';
  for (const path of ['name', 'wire_api', 'experimental_bearer_token']) {
    const actual = editCodexDocument(original, [
      { path: ['model_providers', 'proxy', path], next: { present: false } },
    ]);
    const parsed = Bun.TOML.parse(actual);
    expect(parsed.model_providers.proxy.custom).toBe('keep');
    expect(actual).toContain('[mcp_servers.local]\ncommand = "mcp"');
    expect(actual).not.toContain(`${path} =`);
  }
});

test('removes an explicitly managed provider table after deleting all managed fields', () => {
  const original =
    '# before\n[model_providers.proxy]\n' +
    'name = "aio-proxy"\nbase_url = "url"\nwire_api = "responses"\n' +
    'requires_openai_auth = true\nexperimental_bearer_token = "token"\n\n' +
    '[mcp_servers.local]\ncommand = "mcp"\n';
  const edits = ['name', 'base_url', 'wire_api', 'requires_openai_auth', 'experimental_bearer_token'].map((key) => ({
    path: ['model_providers', 'proxy', key],
    next: { present: false as const },
  }));
  const actual = editCodexDocument(original, edits);
  expect(actual).toBe('# before\n\n[mcp_servers.local]\ncommand = "mcp"\n');
  expect(readCodexDocument(actual).providerIds).toEqual([]);
});

test('rejects a provider ID containing a control character before trimming', () => {
  expect(() => validateCodexProviderId('proxy\n')).toThrow(/control/i);
});
