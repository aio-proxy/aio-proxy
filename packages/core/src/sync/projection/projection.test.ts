import { expect, test } from 'bun:test';

import { isPluginRequirement, type JsonValue } from '../protocol';
import { includedEntity, storedAccount } from '../test-support';
import { overlayLocal, projectCommitted } from './projection';

test('includes required plugin secrets without excluded account or proxies', () => {
  const work = includedEntity('p-work', 'provider', 'work');
  const plugin = includedEntity('plugin-demo', 'plugin-business', '@example/business');
  const result = projectCommitted(
    {
      raw: {
        proxy: 'http://user:proxy-secret@localhost:8080',
        plugins: [['@example/business', { endpoint: '{{env.ENDPOINT}}' }]],
        providers: {
          work: {
            kind: 'oauth',
            plugin: '@example/business',
            capability: 'first',
            proxy: 'http://user:provider-proxy@localhost:8080',
          },
          personal: { kind: 'oauth', plugin: '@example/business', capability: 'second' },
        },
      },
      accounts: new Map([
        ['work', storedAccount('work', 'work-token')],
        ['personal', storedAccount('personal', 'personal-token')],
      ]),
      pluginSecrets: new Map([['@example/business', { token: 'plugin-secret' }]]),
      pluginVersions: new Map([['@example/business', '1.0.0']]),
    },
    [work, plugin],
  );
  const uploaded = JSON.stringify([...result.entities.values(), ...result.accounts.values()]);
  expect(uploaded).toContain('plugin-secret');
  expect(uploaded).toContain('work-token');
  expect(uploaded).toContain('{{env.ENDPOINT}}');
  expect(uploaded).not.toContain('personal-token');
  expect(uploaded).not.toContain('proxy-secret');
  expect(uploaded).not.toContain('provider-proxy');
});

test('filters model references into shared and local overlays', () => {
  const work = includedEntity('p-work', 'provider', 'work');
  const personal = { ...includedEntity('p-personal', 'provider', 'personal'), mode: 'excluded' as const };
  const model = includedEntity('m-shared', 'model-rule', 'shared');
  const result = projectCommitted(
    {
      raw: {
        providers: {
          work: { kind: 'api', apiKey: 'work-key' },
          personal: { kind: 'api', apiKey: 'personal-key' },
        },
        router: { models: { shared: { providers: { work: {}, personal: { weight: 2 } } } } },
      },
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map(),
    },
    [work, personal, model],
  );

  expect(result.entities.get('m-shared')?.value).toEqual({ providers: { work: {} } });
  // The rule depends on the Provider entity, not on a plugin package: it stays traversable by
  // objectId while activation must not look it up in the plugin installation map.
  const dependencies = result.entities.get('m-shared')?.dependencies ?? [];
  expect(dependencies.map((dependency) => dependency.objectId)).toEqual(['p-work']);
  expect(dependencies.filter(isPluginRequirement)).toEqual([]);
  expect(result.local.router).toEqual({ models: { shared: { providers: { personal: { weight: 2 } } } } });
  expect(overlayLocal({ router: { models: { shared: { providers: { work: {} } } } } }, result.local, [model])).toEqual({
    providers: { personal: { kind: 'api', apiKey: 'personal-key' } },
    router: { models: { shared: { providers: { work: {}, personal: { weight: 2 } } } } },
  });
});

test('shares service and routing values while retaining raw env templates and local proxies', () => {
  const provider = includedEntity('p-api', 'provider', 'api');
  const service = includedEntity('service', 'service-access', 'server');
  const routing = includedEntity('routing', 'routing-defaults', 'router');
  const result = projectCommitted(
    {
      raw: {
        proxy: 'http://user:secret@localhost:8080',
        server: {
          host: '127.0.0.1',
          port: 9317,
          apiKeys: [{ key: '{{env.AIO_PROXY_API_KEY}}', label: 'CI' }],
          password: '{{env.DASHBOARD_PASSWORD}}',
          retry: { retryAfterCapMs: 5000 },
        },
        router: { modelContextAggregation: 'max', models: {} },
        providers: {
          api: {
            kind: 'api',
            apiKey: '{{env.UPSTREAM_KEY}}',
            proxy: 'http://provider-secret@localhost:8080',
          },
        },
      },
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map(),
    },
    [provider, service, routing],
  );

  expect(result.entities.get('p-api')?.value).toEqual({ kind: 'api', apiKey: '{{env.UPSTREAM_KEY}}' });
  expect(result.entities.get('service')?.value).toEqual({
    apiKeys: [{ key: '{{env.AIO_PROXY_API_KEY}}', label: 'CI' }],
    password: '{{env.DASHBOARD_PASSWORD}}',
  });
  expect(result.entities.get('routing')?.value).toEqual({
    retry: { retryAfterCapMs: 5000 },
    modelContextAggregation: 'max',
  });
  expect(result.local).toEqual({
    proxy: 'http://user:secret@localhost:8080',
    server: { host: '127.0.0.1', port: 9317 },
    router: { models: {} },
    providers: { api: { proxy: 'http://provider-secret@localhost:8080' } },
  });
});

test('excludes overridden local paths from the published body and keeps an untracked local provider local', () => {
  const provider = {
    ...includedEntity('p-work', 'provider', 'work'),
    overrides: [
      { path: ['options', 'nested', 'shared'], value: undefined },
      { path: ['options', 'nested', 'local'], value: 'machine' },
    ],
  };
  const result = projectCommitted(
    {
      raw: {
        providers: {
          work: {
            kind: 'api',
            options: { nested: { shared: 'cloud', local: 'authored' } },
          },
          personal: { kind: 'api', apiKey: 'local-key' },
        },
      },
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map(),
    },
    [provider],
  );

  // An overridden path is a machine-local decision: it is never published, so neither the local
  // value nor whatever this device authored at that path reaches another device.
  expect(result.entities.get('p-work')?.value).toEqual({
    kind: 'api',
    options: { nested: {} },
  });
  const uploaded = JSON.stringify([...result.entities.values()]);
  expect(uploaded).not.toContain('machine');
  expect(uploaded).not.toContain('authored');
  expect(result.local.providers).toEqual({ personal: { kind: 'api', apiKey: 'local-key' } });
  expect(
    overlayLocal({ providers: { work: { kind: 'api', options: { nested: { local: 'cloud' } } } } }, result.local, [
      provider,
    ]),
  ).toEqual({
    providers: {
      work: { kind: 'api', options: { nested: { local: 'machine' } } },
      personal: { kind: 'api', apiKey: 'local-key' },
    },
  });
});

test('does not copy a plugin secret for an AI SDK executable package', () => {
  const packageEntity = includedEntity('plugin-sdk', 'plugin-business', '@ai-sdk/example');
  const provider = includedEntity('p-sdk', 'provider', 'sdk');
  const result = projectCommitted(
    {
      raw: { providers: { sdk: { kind: 'ai-sdk', packageName: '@ai-sdk/example' } } },
      accounts: new Map(),
      pluginSecrets: new Map([['@ai-sdk/example', { token: 'must-not-share' }]]),
      pluginVersions: new Map([['@ai-sdk/example', '2.0.0']]),
    },
    [provider, packageEntity],
  );

  expect(result.entities.get('plugin-sdk')?.value).toEqual({
    packageName: '@ai-sdk/example',
    version: '2.0.0',
  });
  expect(JSON.stringify(result)).not.toContain('must-not-share');
});

test('rejects non JSON plugin secrets before projection', () => {
  const plugin = includedEntity('plugin-demo', 'plugin-business', '@example/business');
  expect(() =>
    projectCommitted(
      {
        raw: { plugins: ['@example/business'] },
        accounts: new Map(),
        pluginSecrets: new Map([['@example/business', new Date()]]),
        pluginVersions: new Map([['@example/business', '1.0.0']]),
      },
      [plugin],
    ),
  ).toThrow();
});

test('overlays plugin options without changing the authored plugins representation', () => {
  const plugin = {
    ...includedEntity('plugin-demo', 'plugin-business', '@example/business'),
    overrides: [
      { path: ['options', 'local'], value: 'machine' },
      { path: ['options', 'nested', 'array'], value: ['local-a', 'local-b'] },
      { path: ['options', 'remove'], value: undefined },
    ],
  };
  expect(
    overlayLocal(
      {
        plugins: [['@example/business', { nested: { array: ['cloud'], keep: true }, remove: 'cloud-only' }]],
      },
      {},
      [plugin],
    ),
  ).toEqual({
    plugins: [['@example/business', { nested: { array: ['local-a', 'local-b'], keep: true }, local: 'machine' }]],
  });

  expect(
    overlayLocal({ plugins: ['@example/business'] }, {}, [
      { ...plugin, overrides: [{ path: ['options', 'local'], value: 'machine' }] },
    ]),
  ).toEqual({ plugins: [['@example/business', { local: 'machine' }]] });

  expect(
    overlayLocal({ plugins: [['@example/business', { remove: 'cloud-only' }]] }, {}, [
      { ...plugin, overrides: [{ path: ['options'], value: undefined }] },
    ]),
  ).toEqual({ plugins: ['@example/business'] });
});

test('supports root plugin replacement and deletion overrides', () => {
  const plugin = includedEntity('plugin-demo', 'plugin-business', '@example/business');
  expect(
    overlayLocal({ plugins: [['@example/business', { cloud: true }], '@example/other'] }, {}, [
      {
        ...plugin,
        overrides: [{ path: [], value: { options: { local: true } } }],
      },
    ]),
  ).toEqual({ plugins: [['@example/business', { local: true }], '@example/other'] });

  expect(
    overlayLocal({ plugins: [['@example/business', { cloud: true }], '@example/other'] }, {}, [
      { ...plugin, overrides: [{ path: [], value: undefined }] },
    ]),
  ).toEqual({ plugins: ['@example/other'] });
});

test('omits a selected OAuth provider when its dedicated account is absent', () => {
  const provider = includedEntity('p-work', 'provider', 'work');
  const plugin = includedEntity('plugin-demo', 'plugin-business', '@example/business');
  const result = projectCommitted(
    {
      raw: {
        providers: { work: { kind: 'oauth', plugin: '@example/business', capability: 'first' } },
      },
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map([['@example/business', '1.0.0']]),
    },
    [provider, plugin],
  );
  expect(result.entities.has('p-work')).toBe(false);
  expect(result.accounts.has('p-work')).toBe(false);
  expect(result.entities.has('plugin-demo')).toBe(true);
});

test('publishes an AI SDK provider whose package is no authored plugin, and waits for one that is', () => {
  const provider = includedEntity('p-sdk', 'provider', 'sdk');
  const source = {
    raw: { providers: { sdk: { kind: 'ai-sdk', packageName: '@ai-sdk/missing' } } },
    accounts: new Map(),
    pluginSecrets: new Map(),
    pluginVersions: new Map(),
  };
  // An AI SDK package has no descriptor and no registry version, so demanding an object for it would
  // keep the Provider unpublished forever.
  const result = projectCommitted(source, [provider]);
  expect(result.entities.get('p-sdk')?.dependencies).toEqual([]);
  expect([...result.accounts.keys()]).toEqual([]);
  expect([...result.entities.keys(), ...result.accounts.keys()]).not.toContain('generated');

  // Listing the package in `plugins` makes it an object the Provider must name, so its version has to
  // arrive before either can be published.
  const plugin = includedEntity('plugin-sdk', 'plugin-business', '@ai-sdk/missing');
  const missingVersion = projectCommitted(source, [provider, plugin]);
  expect([...missingVersion.entities.keys()]).toEqual([]);
  expect([...missingVersion.entities.keys(), ...missingVersion.accounts.keys()]).not.toContain('generated');
});

test('keeps an OAuth provider pending until its plugin version is known', () => {
  const provider = includedEntity('p-work', 'provider', 'work');
  const plugin = includedEntity('plugin-demo', 'plugin-business', '@example/business');
  const source = {
    raw: { providers: { work: { kind: 'oauth', plugin: '@example/business', capability: 'first' } } },
    accounts: new Map([['work', storedAccount('work', 'token')]]),
    pluginSecrets: new Map(),
    pluginVersions: new Map<string, string>(),
  };
  // Another device cannot verify the credential without the plugin the body names, so an OAuth
  // Provider never takes the AI SDK shortcut of publishing with no dependency.
  expect([...projectCommitted(source, [provider, plugin]).entities.keys()]).toEqual([]);
  const known = projectCommitted({ ...source, pluginVersions: new Map([['@example/business', '1.0.0']]) }, [
    provider,
    plugin,
  ]);
  expect(known.entities.get('p-work')?.dependencies).toEqual([
    { objectId: 'plugin-demo', packageName: '@example/business', version: '1.0.0' },
  ]);
});

test('keeps a local-only provider authored and never turns filtering into cloud deletion', () => {
  const shared = includedEntity('p-work', 'provider', 'work');
  const result = projectCommitted(
    {
      raw: {
        providers: {
          work: { kind: 'api', apiKey: 'shared-key' },
          personal: { kind: 'api', apiKey: 'local-key' },
        },
      },
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map(),
    },
    [shared],
  );
  expect(result.entities.has('p-work')).toBe(true);
  expect(result.entities.size).toBe(1);
  expect(result.local.providers).toEqual({ personal: { kind: 'api', apiKey: 'local-key' } });
});

// The routing-defaults body is flat, but `retry` is authored under `server`. Overlaying it onto
// `router` writes a key nothing reads and leaves the remote retry policy in force.
test('a pinned routing default overlays the section it was authored in', () => {
  const routing = {
    ...includedEntity('routing', 'routing-defaults', 'routing-defaults'),
    overrides: [
      { path: ['retry'], value: { attempts: 1 } },
      { path: ['modelContextAggregation'], value: 'local' },
    ],
  };

  const result = overlayLocal(
    { server: { retry: { attempts: 9 } }, router: { modelContextAggregation: 'remote', models: {} } },
    {},
    [routing],
  );

  expect(result).toEqual({
    server: { retry: { attempts: 1 } },
    router: { modelContextAggregation: 'local', models: {} },
  });
});

// A model name is user data, so a published rule can be named `toString`. Once that rule leaves the
// configuration the projection has to report it as gone; reading the name off the prototype instead
// projected a function and threw, leaving the commit unconfirmed and the cloud rule alive.
test('an included rule named after a prototype member projects its deletion', () => {
  const rule = includedEntity('m-tostring', 'model-rule', 'toString');

  const result = projectCommitted(
    { raw: { router: { models: {} } }, accounts: new Map(), pluginSecrets: new Map(), pluginVersions: new Map() },
    [rule],
  );

  expect(result.entities.has('m-tostring')).toBe(false);
});

// `__proto__` is a valid Provider ID and model name. A plain assignment for that key hits the
// prototype setter, so the excluded entry would silently vanish from what is written back to disk.
test('excluded prototype-named entries survive the device-local projection', () => {
  const provider = { ...includedEntity('p-proto', 'provider', '__proto__'), mode: 'excluded' as const };
  const model = { ...includedEntity('m-proto', 'model-rule', '__proto__'), mode: 'excluded' as const };
  const raw = JSON.parse(
    '{"providers":{"__proto__":{"kind":"api","apiKey":"local"}},"router":{"models":{"__proto__":{"providers":{}}}}}',
  ) as Record<string, JsonValue>;

  const result = projectCommitted({ raw, accounts: new Map(), pluginSecrets: new Map(), pluginVersions: new Map() }, [
    provider,
    model,
  ]);

  const providers = result.local['providers'] as Record<string, JsonValue>;
  const models = (result.local['router'] as Record<string, JsonValue>)['models'] as Record<string, JsonValue>;
  expect(Object.hasOwn(providers, '__proto__')).toBe(true);
  expect(Object.getOwnPropertyDescriptor(providers, '__proto__')?.value).toEqual({ kind: 'api', apiKey: 'local' });
  expect(Object.hasOwn(models, '__proto__')).toBe(true);
});
