import { expect, test } from 'bun:test';

import { runCodexWizard } from './index';

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
        return { token: 'aio-proxy-local', kind: 'placeholder', verified: true };
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
    saveConfig: async (id, token) => {
      expect(token).toBe('aio-proxy-local');
      events.push('save');
      return { status: 'configured', providerId: id };
    },
    migrateSessions: async () => {
      throw new Error('unexpected migration');
    },
  });
  expect(events).toEqual(['migration-question', 'resolve-key', 'save']);
  expect(inspectedProvider).toBe('custom');
  expect(result).toMatchObject({ target: 'codex', providerId: 'custom', migration: { status: 'declined' } });
  expect(JSON.stringify(result)).not.toContain('aio-proxy-local');
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
    saveConfig: async () => {
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
    saveConfig: async (providerId) => ({ status: 'configured', providerId }),
    migrateSessions: async () => {
      throw new Error('unexpected migration');
    },
  });
  expect(previousProvider).toBe('openai');
  expect(result.migration).toEqual({ status: 'declined' });
});
