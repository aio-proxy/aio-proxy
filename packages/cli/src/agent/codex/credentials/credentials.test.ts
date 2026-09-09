import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AtomicConfigCommitUncertainError, AtomicConfigFile } from '@aio-proxy/core';

import { CredentialError, inspectProxyKeys } from './credentials';

const setFetch = (fetch: () => Promise<Response>): void => {
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
};

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
    let generated = false;
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      endpoint: 'http://127.0.0.1:9317',
      loadEnvironment() {},
      readEnvironment: () => ({}),
      randomKey: () => {
        generated = true;
        return 'sk-never';
      },
      reload: async () => {
        throw new Error('must not reload');
      },
      check: async () => 'ok',
    });
    expect(snapshot.choices).toEqual([]);
    expect(await snapshot.resolve({ kind: 'none' }, 'aio-proxy')).toEqual({
      token: 'aio-proxy-local',
      kind: 'placeholder',
      verified: false,
    });
    expect(generated).toBe(false);
    expect(await Bun.file(path).text()).toBe(`${before}\n`);
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
      endpoint: 'http://127.0.0.1:9317',
      loadEnvironment() {},
      readEnvironment: () => ({ TEST_KEY: secret }),
      randomKey: () => 'sk-never',
      reload: async () => {},
      check: async (token) => (token === secret ? 'ok' : 'unauthorized'),
    });
    expect(snapshot.choices).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    await expect(snapshot.resolve({ kind: 'existing', id: snapshot.choices[0]!.id }, 'aio-proxy')).resolves.toEqual({
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
      endpoint: 'http://127.0.0.1:9317',
      loadEnvironment() {},
      readEnvironment: () => ({}),
      randomKey: () => 'sk-never',
      reload: async () => {},
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
    await expect(
      snapshot.resolve({ kind: 'existing', id: snapshot.choices[0]!.id }, 'aio-proxy'),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_SELECTION_STALE',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('created key appends to authored entries and keeps templates intact', async () => {
  const { root, path } = await fixture({
    providers: {},
    server: {
      port: 9317,
      password: 'dashboard',
      apiKeys: [{ key: '{{env.OLD_KEY}}', label: 'old', metadata: { owner: 'team' } }],
    },
  });
  const previous = globalThis.fetch;
  try {
    setFetch(async () => Response.json({ status: 'ok' }));
    let reloads = 0;
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      endpoint: 'http://proxy.test',
      loadEnvironment() {},
      readEnvironment: () => ({ OLD_KEY: 'sk-old' }),
      randomKey: () => 'sk-created',
      reload: async () => {
        reloads += 1;
      },
      check: async (token) => (token === 'sk-created' ? 'ok' : 'unauthorized'),
    });
    await expect(snapshot.resolve({ kind: 'new' }, 'codex')).resolves.toMatchObject({
      token: 'sk-created',
      kind: 'created',
      label: 'Codex: codex',
      verified: true,
    });
    expect(reloads).toBe(1);
    expect(JSON.parse(await Bun.file(path).text())).toMatchObject({
      server: {
        password: 'dashboard',
        apiKeys: [
          { key: '{{env.OLD_KEY}}', label: 'old' },
          { key: 'sk-created', label: 'Codex: codex' },
        ],
      },
    });
    expect(JSON.parse(await Bun.file(path).text()).server.apiKeys[0]).toEqual({
      key: '{{env.OLD_KEY}}',
      label: 'old',
      metadata: { owner: 'team' },
    });
  } finally {
    globalThis.fetch = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid configuration is not treated as keyless', async () => {
  const { root, path } = await fixture({ providers: {}, server: { port: 'invalid', apiKeys: [] } });
  try {
    await expect(
      inspectProxyKeys({
        file: new AtomicConfigFile(path),
        endpoint: 'http://127.0.0.1:9317',
        loadEnvironment() {},
        readEnvironment: () => ({}),
        randomKey: () => 'sk-never',
        reload: async () => {},
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
      endpoint: 'http://127.0.0.1:9317',
      loadEnvironment() {},
      readEnvironment: () => ({}),
      randomKey: () => 'sk-never',
      reload: async () => {},
      check: async () => 'ok',
    });
    await Bun.write(
      path,
      JSON.stringify({
        providers: {},
        server: { apiKeys: [{ key: 'sk-extra', label: 'extra', metadata: { owner: 'two' } }] },
      }),
    );
    await expect(snapshot.resolve({ kind: 'existing', id: snapshot.choices[0]!.id }, 'codex')).rejects.toMatchObject({
      code: 'CREDENTIAL_SELECTION_STALE',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('offline proxy keeps a created key unverified without reloading', async () => {
  const { root, path } = await fixture({ providers: {}, server: { apiKeys: [{ key: 'sk-old' }] } });
  const previous = globalThis.fetch;
  try {
    setFetch(async () => {
      throw new Error('offline');
    });
    let reloads = 0;
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      endpoint: 'http://proxy.test',
      loadEnvironment() {},
      readEnvironment: () => ({}),
      randomKey: () => 'sk-created-offline',
      reload: async () => {
        reloads += 1;
      },
      check: async () => 'ok',
    });
    await expect(snapshot.resolve({ kind: 'new' }, 'codex')).resolves.toMatchObject({
      token: 'sk-created-offline',
      verified: false,
    });
    expect(reloads).toBe(0);
  } finally {
    globalThis.fetch = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('reload rejection is surfaced without leaving the generated key behind', async () => {
  const { root, path } = await fixture({ providers: {}, server: { apiKeys: [{ key: 'sk-old' }] } });
  const previous = globalThis.fetch;
  try {
    setFetch(async () => Response.json({ status: 'ok' }));
    let reloads = 0;
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      endpoint: 'http://proxy.test',
      loadEnvironment() {},
      readEnvironment: () => ({}),
      randomKey: () => 'sk-rejected',
      reload: async () => {
        reloads += 1;
        if (reloads === 1) throw new Error('invalid reload');
      },
      check: async () => 'ok',
    });
    await expect(snapshot.resolve({ kind: 'new' }, 'codex')).rejects.toMatchObject({
      code: 'CREDENTIAL_RELOAD_REJECTED',
    });
    expect(reloads).toBe(2);
    expect(await Bun.file(path).text()).not.toContain('sk-rejected');
  } finally {
    globalThis.fetch = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('online-to-offline verification is uncertain and retains the candidate key', async () => {
  const { root, path } = await fixture({ providers: {}, server: { apiKeys: [{ key: 'sk-old' }] } });
  const previous = globalThis.fetch;
  try {
    setFetch(async () => Response.json({ status: 'ok' }));
    let reloads = 0;
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      endpoint: 'http://proxy.test',
      loadEnvironment() {},
      readEnvironment: () => ({}),
      randomKey: () => 'sk-online-offline',
      reload: async () => {
        reloads += 1;
      },
      check: async () => 'offline',
    });
    await expect(snapshot.resolve({ kind: 'new' }, 'codex')).rejects.toMatchObject({
      code: 'CREDENTIAL_COMMIT_UNCERTAIN',
    });
    expect(reloads).toBe(1);
    expect(await Bun.file(path).text()).toContain('sk-online-offline');
  } finally {
    globalThis.fetch = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('an uncertain atomic commit is reconciled without deleting a possibly-used key', async () => {
  const { root, path } = await fixture({ providers: {}, server: { apiKeys: [{ key: 'sk-old' }] } });
  const previous = globalThis.fetch;
  try {
    setFetch(async () => Response.json({ status: 'ok' }));
    const actual = new AtomicConfigFile(path);
    const file = {
      read: () => actual.read(),
      transaction: async (mutate: Parameters<AtomicConfigFile['transaction']>[0]) => {
        const current = await actual.read();
        const { next } = await mutate(current);
        await Bun.write(path, `${JSON.stringify(next)}\n`);
        throw new AtomicConfigCommitUncertainError();
      },
    } as unknown as AtomicConfigFile;
    let reloads = 0;
    const snapshot = await inspectProxyKeys({
      file,
      endpoint: 'http://proxy.test',
      loadEnvironment() {},
      readEnvironment: () => ({}),
      randomKey: () => 'sk-uncertain',
      reload: async () => {
        reloads += 1;
      },
      check: async () => 'ok',
    });
    await expect(snapshot.resolve({ kind: 'new' }, 'codex')).rejects.toMatchObject({
      code: 'CREDENTIAL_COMMIT_UNCERTAIN',
    });
    expect(reloads).toBe(0);
    expect(await Bun.file(path).text()).toContain('sk-uncertain');
  } finally {
    globalThis.fetch = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('credential errors never include the token', async () => {
  const token = 'sk-private-test-token';
  const { root, path } = await fixture({ providers: {}, server: { apiKeys: [{ key: 'sk-old' }] } });
  const previous = globalThis.fetch;
  try {
    setFetch(async () => Response.json({ status: 'ok' }));
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path),
      endpoint: 'http://proxy.test',
      loadEnvironment() {},
      readEnvironment: () => ({}),
      randomKey: () => token,
      reload: async () => {},
      check: async () => 'unauthorized',
    });
    const error = await snapshot.resolve({ kind: 'new' }, 'codex').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CredentialError);
    expect(String(error)).not.toContain(token);
  } finally {
    globalThis.fetch = previous;
    await rm(root, { recursive: true, force: true });
  }
});
