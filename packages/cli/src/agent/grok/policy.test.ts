import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { grokAuthCommand } from './grok';
import { checkGrokPolicy, readGrokPolicy } from './policy';

const ENDPOINT = 'http://127.0.0.1:9317';
const COMMAND = "'/opt/bin/aio-proxy' agent auth grok --installation-id x";
const SECRET = 'sk-external-secret-value';
const emptyPolicy = { env: {}, sources: [] as const };

test('quoted helper command passes the exact installation id', async () => {
  const root = await mkdtemp(join(tmpdir(), "grok entry ' "));
  const exe = join(root, 'aio-proxy');
  try {
    await writeFile(exe, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const child = Bun.spawn(['/bin/sh', '-c', grokAuthCommand(exe, '11111111-1111-4111-8111-111111111111')], {
      stdout: 'pipe',
    });
    expect(await new Response(child.stdout).text()).toBe(
      'agent\nauth\ngrok\n--installation-id\n11111111-1111-4111-8111-111111111111\n',
    );
    expect(await child.exited).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an external GROK_* URL conflicts on the field path without leaking values', () => {
  const text = '[ui]\ntheme = "dark"\n';
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, {
    env: { GROK_MODELS_BASE_URL: 'https://api.x.ai/v1' },
    sources: [],
  });
  expect(conflicts).toContain('endpoints.models_base_url');
  expect(conflicts.join(',')).not.toContain('https://api.x.ai');
  expect(text).toBe('[ui]\ntheme = "dark"\n');
});

test('the same origin GROK_* value is allowed', () => {
  expect(
    checkGrokPolicy('[ui]\ntheme = "dark"\n', ENDPOINT, COMMAND, {
      env: { GROK_MODELS_BASE_URL: `${ENDPOINT}/v1` },
      sources: [],
    }),
  ).toEqual([]);
});

test('a user catalog alias beside the owned list URL is a conflict', () => {
  const text = `[endpoints]\nmodels_list_url = "${ENDPOINT}/v1/models"\nmodels_endpoint = "https://api.x.ai/v1/models"\n`;
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy);
  expect(conflicts).toContain('endpoints.models_list_url');
  expect(conflicts).toContain('endpoints.models_endpoint');
  expect(conflicts.join(',')).not.toContain('https://api.x.ai');
});

test('a same-origin user catalog alias is still an alias conflict', () => {
  const text = `[endpoints]\nmodels_list_url = "${ENDPOINT}/v1/models"\nmodels_endpoint = "${ENDPOINT}/v1/models"\n`;
  expect(checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy)).toContain('endpoints.models_endpoint');
});

test('the owned catalog URL alone is not an alias conflict', () => {
  const text = `[endpoints]\nmodels_list_url = "${ENDPOINT}/v1/models"\n`;
  expect(checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy)).toEqual([]);
});

test('a requirements pin with both catalog aliases is a conflict', () => {
  const text = `[endpoints]\nmodels_list_url = "${ENDPOINT}/v1/models"\n`;
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, {
    env: {},
    sources: [
      {
        path: '/etc/grok/requirements.toml',
        kind: 'toml',
        text: `[endpoints]\nmodels_list_url = "${ENDPOINT}/v1/models"\nmodels_endpoint = "https://api.x.ai/v1/models"\n`,
      },
    ],
  });
  expect(conflicts).toContain('endpoints.models_list_url');
  expect(conflicts).toContain('endpoints.models_endpoint');
  expect(conflicts.join(',')).not.toContain('https://api.x.ai');
});

test('an overlay with both catalog aliases is a conflict', () => {
  const text = `[endpoints]\nmodels_list_url = "${ENDPOINT}/v1/models"\n`;
  const overlay = JSON.stringify({
    endpoints: { models_list_url: `${ENDPOINT}/v1/models`, models_endpoint: 'https://api.x.ai/v1/models' },
  });
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, {
    env: {},
    sources: [{ path: 'GROK_CONFIG', kind: 'json', text: overlay }],
  });
  expect(conflicts).toContain('endpoints.models_list_url');
  expect(conflicts).toContain('endpoints.models_endpoint');
});

test('alias requirements pins conflict on the authored path', () => {
  const text = '[models]\ndefault = "keep"\n';
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, {
    env: {},
    sources: [
      {
        path: '/etc/grok/requirements.toml',
        kind: 'toml',
        text: '[endpoints]\nmodels_endpoint = "https://api.x.ai/v1/models"\n',
      },
    ],
  });
  expect(conflicts).toContain('endpoints.models_endpoint');
  expect(text).toBe('[models]\ndefault = "keep"\n');
});

test('a matching requirements pin ignores a foreign GROK_* env', () => {
  const text = '[ui]\ntheme = "dark"\n';
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, {
    env: { GROK_MODELS_BASE_URL: 'https://api.x.ai/v1' },
    sources: [
      {
        path: '/etc/grok/requirements.toml',
        kind: 'toml',
        text: `[endpoints]\nmodels_base_url = "${ENDPOINT}/v1"\n`,
      },
    ],
  });
  expect(conflicts).toEqual([]);
  expect(text).toBe('[ui]\ntheme = "dark"\n');
});

test('a requirements pin of the auth helper command is a field conflict', () => {
  const text = '[ui]\ntheme = "dark"\n';
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, {
    env: {},
    sources: [
      {
        path: '/etc/grok/requirements.toml',
        kind: 'toml',
        text: '[auth]\nauth_provider_command = "/usr/bin/other-auth"\n',
      },
    ],
  });
  expect(conflicts).toContain('auth.auth_provider_command');
  expect(text).toBe('[ui]\ntheme = "dark"\n');
});

test('unrelated UI and MCP settings are not routing conflicts', () => {
  const text = `[ui]\ntheme = "dark"\n[mcp_servers.local]\ncommand = "mcp"\n`;
  expect(checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy)).toEqual([]);
});

test('an explicit external model is refused by field path', () => {
  const text = `[model.openai]\nbase_url = "https://api.openai.com/v1"\napi_key = "${SECRET}"\n`;
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy);
  expect(conflicts).toContain('model.openai.base_url');
  expect(conflicts.join(',')).not.toContain(SECRET);
  expect(text).toContain(SECRET);
});

test('a custom same-origin model is allowed', () => {
  const text = `[model.local]\nbase_url = "${ENDPOINT}/v1"\nname = "Mine"\n`;
  expect(checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy)).toEqual([]);
});

test('XAI_API_KEY and OIDC are not conflicts by themselves', () => {
  const text = `[grok_com_config.oidc]\nissuer = "https://acme.okta.com"\nclient_id = "abc"\n`;
  expect(
    checkGrokPolicy(text, ENDPOINT, COMMAND, {
      env: { XAI_API_KEY: SECRET, GROK_OIDC_ISSUER: 'https://acme.okta.com' },
      sources: [],
    }),
  ).toEqual([]);
});

test('forced team login conflicts on the specific field', () => {
  const text = `[auth]\nforce_login_team_uuid = "11111111-1111-4111-8111-111111111111"\n`;
  expect(checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy)).toContain('auth.force_login_team_uuid');
});

test('per-model Authorization headers conflict without leaking secrets', () => {
  const text = `[model.proxy]\nextra_headers = { Authorization = "Bearer ${SECRET}" }\n`;
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy);
  expect(conflicts).toContain('model.proxy.extra_headers.Authorization');
  expect(conflicts.join(',')).not.toContain(SECRET);
});

test('missing policy files are skipped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-policy-missing-'));
  try {
    const visible = await readGrokPolicy(root, {});
    expect(visible.sources).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an existing illegal policy file cannot be ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-policy-bad-'));
  try {
    await writeFile(join(root, 'managed_config.toml'), '{ not toml', { mode: 0o600 });
    await expect(readGrokPolicy(root, {})).rejects.toThrow(/unverifiable/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable policy file cannot be ignored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-policy-unreadable-'));
  const path = join(root, 'requirements.toml');
  try {
    await writeFile(path, 'models_base_url = "https://api.x.ai/v1"\n', { mode: 0o600 });
    await chmod(path, 0o000);
    await expect(readGrokPolicy(root, {})).rejects.toThrow(/unverifiable/i);
  } finally {
    await chmod(path, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('GROK_CONFIG overlay with an external model is a field conflict', () => {
  const text = '[ui]\ntheme = "dark"\n';
  const overlay = JSON.stringify({ model: { remote: { base_url: 'https://api.openai.com/v1', api_key: SECRET } } });
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, {
    env: {},
    sources: [{ path: 'GROK_CONFIG', kind: 'json', text: overlay }],
  });
  expect(conflicts).toContain('model.remote.base_url');
  expect(conflicts.join(',')).not.toContain(SECRET);
  expect(text).toBe('[ui]\ntheme = "dark"\n');
});

test('GROK_CONFIG overlay with a foreign models_base_url is a field conflict', () => {
  const text = '[ui]\ntheme = "dark"\n';
  const overlay = JSON.stringify({ endpoints: { models_base_url: 'https://api.x.ai/v1' } });
  const conflicts = checkGrokPolicy(text, ENDPOINT, COMMAND, {
    env: {},
    sources: [{ path: 'GROK_CONFIG', kind: 'json', text: overlay }],
  });
  expect(conflicts).toContain('endpoints.models_base_url');
  expect(conflicts.join(',')).not.toContain('https://api.x.ai');
  expect(text).toBe('[ui]\ntheme = "dark"\n');
});

test('an external model provider endpoint is refused', () => {
  const text = `[model_providers.proxy]\nbase_url = "https://api.openai.com/v1"\n`;
  expect(checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy)).toContain('model_providers.proxy.base_url');
});

test('an unparseable model URL is refused', () => {
  const text = `[model.bad]\nbase_url = "not-a-url"\n`;
  expect(checkGrokPolicy(text, ENDPOINT, COMMAND, emptyPolicy)).toContain('model.bad.base_url');
});

test('GROK_CONFIG_PATH overlay is collected when present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-policy-overlay-'));
  const overlay = join(root, 'extra.json');
  try {
    await writeFile(overlay, '{"ui":{"theme":"dark"}}\n', { mode: 0o600 });
    const visible = await readGrokPolicy(root, { GROK_CONFIG_PATH: overlay });
    expect(visible.sources).toEqual([{ path: overlay, text: '{"ui":{"theme":"dark"}}\n', kind: 'json' }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
