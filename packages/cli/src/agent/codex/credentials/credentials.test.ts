import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AtomicConfigFile } from '@aio-proxy/core';

import { CredentialError, inspectProxyKeys, probeProxyApiKey } from './credentials';

const fixture = async (value: unknown): Promise<{ readonly root: string; readonly path: string }> => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-key-'));
  const path = join(root, 'config.json');
  await Bun.write(path, `${JSON.stringify(value)}\n`);
  return { root, path };
};

test('keyless proxy stays keyless and uses a non-secret explicit token', async () => {
  const before = '{"providers":{},"server":{"apiKeys":[]}}';
  const { root, path } = await fixture(JSON.parse(before));
  try {
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      loadEnvironment() {},
      readEnvironment: () => ({}),
      check: async () => 'ok',
    });
    expect(snapshot.choices).toEqual([]);
    expect(await snapshot.resolve({ kind: 'none' })).toEqual({
      token: 'aio-proxy-local',
      kind: 'placeholder',
      verified: false,
    });
    expect(await Bun.file(path).text()).toBe(`${before}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keyless placeholder selection becomes stale when a key is added', async () => {
  const { root, path } = await fixture({ providers: {}, server: { apiKeys: [] } });
  try {
    const deps = {
      file: new AtomicConfigFile(path),
      loadEnvironment() {},
      readEnvironment: () => ({}),
      check: async () => 'ok' as const,
    };
    const snapshot = await inspectProxyKeys(deps);
    await Bun.write(path, `${JSON.stringify({ providers: {}, server: { apiKeys: [{ key: 'sk-added' }] } })}\n`);
    await expect(snapshot.resolve({ kind: 'none' })).rejects.toMatchObject({ code: 'CREDENTIAL_SELECTION_STALE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing template keys resolve privately and expose only an opaque choice', async () => {
  const secret = 'sk-test-existing';
  const { root, path } = await fixture({
    providers: {},
    server: { apiKeys: [{ key: '{{env.TEST_KEY}}', label: 'CI' }] },
  });
  try {
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      loadEnvironment() {},
      readEnvironment: () => ({ TEST_KEY: secret }),
      check: async (token) => (token === secret ? 'ok' : 'unauthorized'),
    });
    expect(snapshot.choices).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    await expect(snapshot.resolve({ kind: 'existing', id: snapshot.choices[0]!.id })).resolves.toEqual({
      token: secret,
      kind: 'existing',
      label: 'CI',
      verified: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selection becomes stale when authored keys are reordered', async () => {
  const { root, path } = await fixture({
    providers: {},
    server: {
      apiKeys: [
        { key: 'sk-first', label: 'first' },
        { key: 'sk-second', label: 'second' },
      ],
    },
  });
  try {
    const deps = {
      file: new AtomicConfigFile(path),
      loadEnvironment() {},
      readEnvironment: () => ({}),
      check: async () => 'ok' as const,
    };
    const snapshot = await inspectProxyKeys(deps);
    await Bun.write(
      path,
      JSON.stringify({
        providers: {},
        server: {
          apiKeys: [
            { key: 'sk-second', label: 'second' },
            { key: 'sk-first', label: 'first' },
          ],
        },
      }),
    );
    await expect(snapshot.resolve({ kind: 'existing', id: snapshot.choices[0]!.id })).rejects.toMatchObject({
      code: 'CREDENTIAL_SELECTION_STALE',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid configuration is not treated as keyless', async () => {
  const { root, path } = await fixture({ providers: {}, server: { port: 'invalid', apiKeys: [] } });
  try {
    await expect(
      inspectProxyKeys({
        file: new AtomicConfigFile(path),
        loadEnvironment() {},
        readEnvironment: () => ({}),
        check: async () => 'ok',
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_CONFIG_INVALID' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('selection becomes stale when an authored extra field changes', async () => {
  const { root, path } = await fixture({
    providers: {},
    server: { apiKeys: [{ key: 'sk-extra', label: 'extra', metadata: { owner: 'one' } }] },
  });
  try {
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      loadEnvironment() {},
      readEnvironment: () => ({}),
      check: async () => 'ok',
    });
    await Bun.write(
      path,
      JSON.stringify({
        providers: {},
        server: { apiKeys: [{ key: 'sk-extra', label: 'extra', metadata: { owner: 'two' } }] },
      }),
    );
    await expect(snapshot.resolve({ kind: 'existing', id: snapshot.choices[0]!.id })).rejects.toMatchObject({
      code: 'CREDENTIAL_SELECTION_STALE',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a class-instance catalog when probing a static API key', async () => {
  await expect(
    probeProxyApiKey({
      endpoint: 'http://127.0.0.1:9',
      token: 'sk-test',
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => new (class Catalog {})(),
        }) as Response,
    }),
  ).resolves.toBe('invalid_response');
});

test('rejects redirects when probing a static API key', async () => {
  const destination = Bun.serve({
    port: 0,
    fetch: () => Response.json({ object: 'list', data: [] }),
  });
  const loopback = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(null, {
        status: 307,
        headers: { location: `http://127.0.0.1:${destination.port}/v1/models` },
      }),
  });
  try {
    await expect(probeProxyApiKey({ endpoint: `http://127.0.0.1:${loopback.port}`, token: 'sk-test' })).resolves.toBe(
      'offline',
    );
  } finally {
    loopback.stop(true);
    destination.stop(true);
  }
});

test('credential errors never include the token', async () => {
  const token = 'sk-private-test-token';
  const { root, path } = await fixture({ providers: {}, server: { apiKeys: [{ key: token }] } });
  try {
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      loadEnvironment() {},
      readEnvironment: () => ({}),
      check: async () => 'unauthorized',
    });
    const error = await snapshot
      .resolve({ kind: 'existing', id: snapshot.choices[0]!.id })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CredentialError);
    expect(String(error)).not.toContain(token);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
