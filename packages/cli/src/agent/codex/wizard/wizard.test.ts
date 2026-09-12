import { expect, test } from 'bun:test';

import { runCodexWizard } from './wizard';

test('skips Key prompt and leaves history when migration is declined', async () => {
  const events: string[] = [];
  let inspectedProvider: string | undefined;
  const result = await runCodexWizard({
    location: {
      home: '/tmp/codex-test',
      configPath: '/tmp/codex-test/config.toml',
      managedRoot: '/tmp/codex-test/.aio-proxy',
      markerPath: '/tmp/codex-test/.aio-proxy/codex-config.json',
    },
    endpoint: 'http://127.0.0.1:9317',
    isTTY: true,
    prompts: {
      providerId: async (value) => {
        expect(value).toBe('aio-proxy');
        return 'custom';
      },
      authMode: async () => 'keep-chatgpt',
      key: async () => {
        throw new Error('unexpected Key prompt');
      },
      sources: async () => ['openai'],
      migrate: async () => {
        events.push('migration-question');
        return false;
      },
    },
    inspectConfig: async () => ({ status: 'absent', activeProviderId: 'openai', changedPaths: [] }),
    occupiedIds: async () => [],
    inspectKeys: async () => ({
      choices: [],
      resolve: async () => {
        events.push('resolve-key');
        return { token: 'aio-proxy-local', kind: 'placeholder', verified: false };
      },
    }),
    inspectSessions: async (providerId) => {
      inspectedProvider = providerId;
      return {
        groups: [{ providerId: 'openai', active: 1, archived: 0 }],
        blocked: [],
        targets: [{ id: 'test-id', sourceProviderId: 'openai', archived: false, storage: 'legacy', revision: 'r1' }],
      };
    },
    resolveCommand: async () => '/tmp/aiop',
    commitSetup: async ({ providerId, auth }) => {
      if (auth.mode !== 'keep-chatgpt') throw new Error('unexpected command auth');
      const credential = await auth.keys.resolve(auth.selection);
      expect(credential.token).toBe('aio-proxy-local');
      events.push('save');
      return {
        status: 'configured',
        providerId,
        authMode: 'keep-chatgpt',
        credential: 'placeholder',
        connection: 'not_checked',
      };
    },
    migrateSessions: async () => {
      throw new Error('unexpected migration');
    },
  });
  expect(events).toEqual(['migration-question', 'resolve-key', 'save']);
  expect(inspectedProvider).toBe('custom');
  expect(result).toMatchObject({
    target: 'codex',
    providerId: 'custom',
    connection: 'not_checked',
    migration: { status: 'declined' },
  });
  expect(JSON.stringify(result)).not.toContain('aio-proxy-local');
});

test('command authentication skips proxy key inspection and returns the installation identity', async () => {
  const events: string[] = [];
  const result = await runCodexWizard({
    location: {
      home: '/tmp/codex-test',
      configPath: '/tmp/codex-test/config.toml',
      managedRoot: '/tmp/codex-test/.aio-proxy',
      markerPath: '/tmp/codex-test/.aio-proxy/codex-config.json',
    },
    endpoint: 'http://127.0.0.1:9317',
    isTTY: true,
    prompts: {
      providerId: async () => 'custom',
      authMode: async () => {
        events.push('mode');
        return 'command';
      },
      key: async () => {
        throw new Error('command must not prompt for keys');
      },
      sources: async () => [],
      migrate: async () => false,
    },
    inspectConfig: async () => ({ status: 'absent', activeProviderId: 'openai', changedPaths: [] }),
    occupiedIds: async () => [],
    inspectKeys: async () => {
      throw new Error('command must not inspect proxy keys');
    },
    inspectSessions: async () => ({ groups: [], blocked: [], targets: [] }),
    resolveCommand: async () => {
      events.push('command');
      return '/tmp/AIO Proxy/bin/aiop';
    },
    commitSetup: async ({ providerId, auth }) => {
      events.push('commit');
      expect(auth).toEqual({ mode: 'command', command: '/tmp/AIO Proxy/bin/aiop' });
      return {
        status: 'configured',
        providerId,
        authMode: 'command',
        credential: 'agent',
        connection: 'ok',
        installationId: '11111111-1111-4111-8111-111111111111',
      };
    },
    migrateSessions: async () => {
      throw new Error('unexpected migration');
    },
  });
  expect(events).toEqual(['mode', 'command', 'commit']);
  expect(result).toMatchObject({
    target: 'codex',
    providerId: 'custom',
    authMode: 'command',
    credential: 'agent',
    installationId: '11111111-1111-4111-8111-111111111111',
  });
});

test('returns a localized non-interactive result before inspecting or writing', async () => {
  let inspected = false;
  const result = await runCodexWizard({
    location: {
      home: '/tmp/codex-test',
      configPath: '/tmp/codex-test/config.toml',
      managedRoot: '/tmp/codex-test/.aio-proxy',
      markerPath: '/tmp/codex-test/.aio-proxy/codex-config.json',
    },
    endpoint: 'http://127.0.0.1:9317',
    isTTY: false,
    prompts: {
      providerId: async () => 'unused',
      authMode: async () => 'keep-chatgpt',
      key: async () => ({ kind: 'none' }),
      sources: async () => [],
      migrate: async () => false,
    },
    inspectConfig: async () => {
      inspected = true;
      throw new Error('unexpected inspection');
    },
    occupiedIds: async () => [],
    inspectKeys: async () => {
      throw new Error('unexpected key inspection');
    },
    inspectSessions: async () => {
      throw new Error('unexpected session inspection');
    },
    resolveCommand: async () => '/tmp/aiop',
    commitSetup: async () => {
      throw new Error('unexpected save');
    },
    migrateSessions: async () => {
      throw new Error('unexpected migration');
    },
  });
  expect(inspected).toBe(false);
  expect(result).toMatchObject({ status: 'cancelled', reason: 'non_interactive', credential: 'none' });
});

test('defaults a first multi-source migration selector to openai', async () => {
  let previousProvider: string | undefined;
  const result = await runCodexWizard({
    location: {
      home: '/tmp/codex-test',
      configPath: '/tmp/codex-test/config.toml',
      managedRoot: '/tmp/codex-test/.aio-proxy',
      markerPath: '/tmp/codex-test/.aio-proxy/codex-config.json',
    },
    endpoint: 'http://127.0.0.1:9317',
    isTTY: true,
    prompts: {
      providerId: async () => 'custom',
      authMode: async () => 'keep-chatgpt',
      key: async () => ({ kind: 'none' }),
      sources: async (groups, previous) => {
        expect(groups.map((group) => group.providerId)).toEqual(['zeta', 'openai']);
        previousProvider = previous;
        return ['openai'];
      },
      migrate: async () => false,
    },
    inspectConfig: async () => ({ status: 'absent', activeProviderId: '', changedPaths: [] }),
    occupiedIds: async () => [],
    inspectKeys: async () => ({
      choices: [],
      resolve: async () => ({ token: 'placeholder', kind: 'placeholder', verified: true }),
    }),
    inspectSessions: async () => ({
      groups: [
        { providerId: 'zeta', active: 1, archived: 0 },
        { providerId: 'openai', active: 1, archived: 0 },
      ],
      blocked: [],
      targets: [
        { id: 'openai-id', sourceProviderId: 'openai', archived: false, storage: 'legacy', revision: 'r1' },
        { id: 'zeta-id', sourceProviderId: 'zeta', archived: false, storage: 'legacy', revision: 'r2' },
      ],
    }),
    resolveCommand: async () => '/tmp/aiop',
    commitSetup: async ({ providerId }) => ({
      status: 'configured',
      providerId,
      authMode: 'keep-chatgpt',
      credential: 'placeholder',
      connection: 'not_checked',
    }),
    migrateSessions: async () => {
      throw new Error('unexpected migration');
    },
  });
  expect(previousProvider).toBe('openai');
  expect(result.migration).toEqual({ status: 'declined' });
});

test('propagates setup failures without attempting migration', async () => {
  const events: string[] = [];
  const error = await runCodexWizard({
    location: {
      home: '/tmp/codex-test',
      configPath: '/tmp/codex-test/config.toml',
      managedRoot: '/tmp/codex-test/.aio-proxy',
      markerPath: '/tmp/codex-test/.aio-proxy/codex-config.json',
    },
    endpoint: 'http://127.0.0.1:9317',
    isTTY: true,
    prompts: {
      providerId: async () => 'custom',
      authMode: async () => 'command',
      key: async () => ({ kind: 'none' }),
      sources: async () => [],
      migrate: async () => false,
    },
    inspectConfig: async () => ({ status: 'absent', activeProviderId: '', changedPaths: [] }),
    occupiedIds: async () => [],
    inspectKeys: async () => ({
      choices: [],
      resolve: async () => {
        throw new Error('command must not inspect keys');
      },
    }),
    inspectSessions: async () => ({ groups: [], blocked: [], targets: [] }),
    resolveCommand: async () => '/tmp/aiop',
    commitSetup: async () => {
      events.push('commit');
      throw new Error('config write failed');
    },
    migrateSessions: async () => {
      events.push('migrate');
      throw new Error('unexpected migration');
    },
  }).catch((cause: unknown) => cause);

  expect(error).toEqual(new Error('config write failed'));
  expect(events).toEqual(['commit']);
});

test('does not report zero side effects when command authorization is aborted', async () => {
  const result = await runCodexWizard({
    location: {
      home: '/tmp/codex-test',
      configPath: '/tmp/codex-test/config.toml',
      managedRoot: '/tmp/codex-test/.aio-proxy',
      markerPath: '/tmp/codex-test/.aio-proxy/codex-config.json',
    },
    endpoint: 'http://127.0.0.1:9317',
    isTTY: true,
    prompts: {
      providerId: async () => 'custom',
      authMode: async () => 'command',
      key: async () => ({ kind: 'none' }),
      sources: async () => [],
      migrate: async () => false,
    },
    inspectConfig: async () => ({ status: 'absent', activeProviderId: 'openai', changedPaths: [] }),
    occupiedIds: async () => [],
    inspectKeys: async () => {
      throw new Error('command must not inspect proxy keys');
    },
    inspectSessions: async () => ({ groups: [], blocked: [], targets: [] }),
    resolveCommand: async () => '/tmp/aiop',
    commitSetup: async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    },
    migrateSessions: async () => {
      throw new Error('unexpected migration');
    },
  });
  expect(result).toMatchObject({
    status: 'cancelled',
    reason: 'authorization_incomplete',
    providerId: 'custom',
    authMode: 'command',
  });
});
