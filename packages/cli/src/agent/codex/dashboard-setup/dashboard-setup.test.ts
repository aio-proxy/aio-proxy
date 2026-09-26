import { expect, mock, test } from 'bun:test';

import type { AgentDeviceCodeResponse, CodexConfigureInput } from '@aio-proxy/types';

import type { CodexSetupSelection, MigrationPreview, MigrationTarget } from '../contracts';
import { buildCodexSetupPlan, configureCodexFromDashboard, type CodexDashboardDeps } from './dashboard-setup';

const ENDPOINT = 'http://127.0.0.1:9317';
const target = (id: string, sourceProviderId: string): MigrationTarget => ({
  id,
  sourceProviderId,
  archived: false,
  storage: 'native',
  revision: `${id}-r1`,
});

function setupFixture(options: { readonly recovery?: boolean } = {}) {
  let preview: MigrationPreview = {
    groups: [
      { providerId: 'openai', active: 2, archived: 0 },
      { providerId: 'other', active: 1, archived: 0 },
    ],
    targets: [target('a', 'openai'), target('b', 'openai'), target('c', 'other')],
    blocked: [],
  };
  const commitSetup = mock(
    async (
      selection: CodexSetupSelection,
      _endpoint: string,
      overrides: { readonly onDevice: (device: AgentDeviceCodeResponse) => Promise<void> },
    ) => {
      if (selection.auth.mode === 'command')
        await overrides.onDevice({ user_code: 'ABCD-EFGH' } as AgentDeviceCodeResponse);
      return {
        status: 'configured' as const,
        providerId: selection.providerId,
        authMode: selection.auth.mode,
        credential: 'agent' as const,
        connection: 'ok' as const,
      };
    },
  );
  const migrateSessions = mock(async (targets: readonly MigrationTarget[]) => ({
    status: 'completed' as const,
    migrated: targets.length,
    skipped: 0,
    conflicts: 0,
    operationId: '3f1d0f6a-4f1e-4b8e-9d7e-2d6f0e7a1b2c',
  }));
  const deps: CodexDashboardDeps = {
    location: {
      home: '/home/me/.codex',
      configPath: '/home/me/.codex/config.toml',
      managedRoot: '/home/me/.codex/aio-proxy',
      markerPath: '/home/me/.codex/aio-proxy/marker.json',
    },
    resolveEndpoint: async () => ENDPOINT,
    inspectConfig: async () => ({ status: 'absent', activeProviderId: 'openai', changedPaths: [] }),
    occupiedIds: async () => ['taken'],
    inspectKeys: async () => ({
      choices: [{ id: 'k1', label: 'Primary' }],
      resolve: async () => ({ token: 'sk-secret', kind: 'existing', verified: true }),
    }),
    inspectSessions: async (providerId) => ({
      ...preview,
      targets: preview.targets.filter((item) => item.sourceProviderId !== providerId),
    }),
    latestMigration: async () => undefined,
    pendingRecovery: async () => options.recovery === true,
    resolveCommand: async () => '/usr/bin/aio-proxy agent auth codex',
    commitSetup,
    migrateSessions,
  };
  return {
    deps,
    commitSetup,
    migrateSessions,
    addSession: () => {
      preview = { ...preview, groups: [...preview.groups, { providerId: 'new', active: 1, archived: 0 }] };
    },
  };
}

const events = () => ({ signal: new AbortController().signal, onDevice: mock((_code: string) => undefined) });

test('the plan exposes choices without key material and a token for the state it shows', async () => {
  const { deps } = setupFixture();
  const plan = await buildCodexSetupPlan(deps);
  expect(plan).toMatchObject({
    defaultProviderId: 'aio-proxy',
    defaultAuthMode: 'keep-chatgpt',
    occupiedProviderIds: ['taken'],
    keyChoices: [{ id: 'k1', label: 'Primary' }],
    sessions: { blocked: 0 },
  });
  expect(JSON.stringify(plan)).not.toContain('sk-secret');
});

test('command mode commits the submitted selection, forwards the device code, and migrates chosen sources', async () => {
  const { deps, commitSetup, migrateSessions } = setupFixture();
  const plan = await buildCodexSetupPlan(deps);
  const input: CodexConfigureInput = {
    providerId: 'aio-proxy',
    auth: { mode: 'command' },
    migrateFrom: ['openai'],
    planToken: plan.planToken,
  };
  const operation = events();
  const result = await configureCodexFromDashboard(input, operation, deps);
  expect(commitSetup.mock.calls[0]?.[0]).toEqual({
    providerId: 'aio-proxy',
    auth: { mode: 'command', command: '/usr/bin/aio-proxy agent auth codex' },
  });
  expect(operation.onDevice).toHaveBeenCalledWith('ABCD-EFGH');
  expect(migrateSessions.mock.calls[0]?.[0].map((item) => item.id)).toEqual(['a', 'b']);
  expect(result).toMatchObject({ status: 'configured', providerId: 'aio-proxy', migration: { migrated: 2 } });
});

test('keep-chatgpt without migration commits the chosen key and leaves sessions alone', async () => {
  const { deps, commitSetup, migrateSessions } = setupFixture();
  const plan = await buildCodexSetupPlan(deps);
  const result = await configureCodexFromDashboard(
    {
      providerId: 'aio-proxy',
      auth: { mode: 'keep-chatgpt', key: { kind: 'existing', id: 'k1' } },
      migrateFrom: [],
      planToken: plan.planToken,
    },
    events(),
    deps,
  );
  const selection = commitSetup.mock.calls[0]?.[0];
  expect(selection?.auth.mode === 'keep-chatgpt' ? selection.auth.selection : undefined).toEqual({
    kind: 'existing',
    id: 'k1',
  });
  expect(migrateSessions).not.toHaveBeenCalled();
  expect(result.migration.status).not.toBe('completed');
});

test('a submission is rejected when the state it was built from changed or is unsafe', async () => {
  const fixture = setupFixture();
  const plan = await buildCodexSetupPlan(fixture.deps);
  const input: CodexConfigureInput = {
    providerId: 'aio-proxy',
    auth: { mode: 'command' },
    migrateFrom: [],
    planToken: plan.planToken,
  };
  await expect(
    configureCodexFromDashboard({ ...input, providerId: 'taken' }, events(), fixture.deps),
  ).rejects.toMatchObject({ code: 'occupied_provider_id' });
  await expect(
    configureCodexFromDashboard({ ...input, providerId: 'openai' }, events(), fixture.deps),
  ).rejects.toMatchObject({ code: 'invalid_provider_id' });
  fixture.addSession();
  await expect(configureCodexFromDashboard(input, events(), fixture.deps)).rejects.toMatchObject({
    code: 'plan_stale',
  });
  expect(fixture.commitSetup).not.toHaveBeenCalled();

  const recovering = setupFixture({ recovery: true });
  await expect(buildCodexSetupPlan(recovering.deps)).rejects.toMatchObject({ code: 'recovery_required' });
});
