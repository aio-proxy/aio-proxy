import { AgentOperationError } from '@aio-proxy/server';
import type { AgentDeviceCodeResponse, CodexConfigureInput, CodexSetupPlan } from '@aio-proxy/types';

import { resolveAgentEndpoint } from '../../control-plane';
import { resolveCodexAuthCommand } from '../command-location';
import { validateCodexProviderId } from '../config-document';
import type {
  CodexLocation,
  CodexSetupCommit,
  CodexSetupSelection,
  ConfigInspection,
  KeySnapshot,
  MigrationPreview,
  MigrationResult,
  MigrationTarget,
} from '../contracts';
import { inspectProxyKeys } from '../credentials';
import { inspectCodexConfig, recoverCodexConfigOperation } from '../managed-config';
import { authContext, configuredLocation, createCredentialDeps, occupiedIds } from '../runtime';
import { inspectCodexSessions, latestRestorableMigration, migrateCodexSessions } from '../sessions';
import { commitCodexSetup, readAuthOperation } from '../setup';
import { runCodexWizard, type CodexConfigureResult, type CodexPrompts } from '../wizard';

export type CodexDashboardDeps = {
  readonly location: CodexLocation;
  readonly resolveEndpoint: () => Promise<string>;
  readonly inspectConfig: () => Promise<ConfigInspection>;
  readonly occupiedIds: () => Promise<readonly string[]>;
  readonly inspectKeys: (endpoint: string) => Promise<KeySnapshot>;
  readonly inspectSessions: (providerId?: string) => Promise<MigrationPreview>;
  readonly latestMigration: () => Promise<string | undefined>;
  /** True when an interrupted CLI or dashboard setup left a journal that must be recovered first. */
  readonly pendingRecovery: () => Promise<boolean>;
  readonly resolveCommand: () => Promise<string>;
  readonly commitSetup: (
    selection: CodexSetupSelection,
    endpoint: string,
    overrides: { readonly signal: AbortSignal; readonly onDevice: (device: AgentDeviceCodeResponse) => Promise<void> },
  ) => Promise<CodexSetupCommit>;
  readonly migrateSessions: (targets: readonly MigrationTarget[], providerId: string) => Promise<MigrationResult>;
};

export const createCodexDashboardDeps = (location: CodexLocation = configuredLocation()): CodexDashboardDeps => ({
  location,
  resolveEndpoint: resolveAgentEndpoint,
  inspectConfig: () => inspectCodexConfig(location),
  occupiedIds: () => occupiedIds(location),
  inspectKeys: (endpoint) => inspectProxyKeys(createCredentialDeps(endpoint)),
  inspectSessions: (providerId) => inspectCodexSessions(location, providerId),
  latestMigration: () => latestRestorableMigration(location),
  pendingRecovery: async () => {
    if ((await readAuthOperation(location)) !== undefined) return true;
    // Declining the confirmation reports a pending journal without touching it.
    return (await recoverCodexConfigOperation(location, async () => false)) === 'declined';
  },
  resolveCommand: resolveCodexAuthCommand,
  commitSetup: (selection, endpoint, overrides) =>
    commitCodexSetup(selection, authContext(location, endpoint, overrides)),
  migrateSessions: (targets, providerId) => migrateCodexSessions({ location, targets, targetProviderId: providerId }),
});

type PlanParts = {
  readonly inspection: ConfigInspection;
  readonly occupied: readonly string[];
  readonly keys: KeySnapshot;
  readonly sessions: MigrationPreview;
};

const readPlanParts = async (deps: CodexDashboardDeps, endpoint: string): Promise<PlanParts> => ({
  inspection: await deps.inspectConfig(),
  occupied: await deps.occupiedIds(),
  keys: await deps.inspectKeys(endpoint),
  sessions: await deps.inspectSessions(),
});

// Binds a submitted form to what the user saw: config, keys, and migratable sessions.
const planToken = ({ inspection, occupied, keys, sessions }: PlanParts): string =>
  new Bun.CryptoHasher('sha256')
    .update(
      JSON.stringify([
        inspection.status,
        inspection.providerId ?? null,
        inspection.authMode ?? null,
        inspection.changedPaths,
        [...occupied].sort(),
        keys.choices.map((choice) => choice.id),
        sessions.groups,
        sessions.blocked.length,
      ]),
    )
    .digest('hex');

export async function buildCodexSetupPlan(deps: CodexDashboardDeps): Promise<CodexSetupPlan> {
  if (await deps.pendingRecovery()) throw new AgentOperationError('recovery_required');
  const parts = await readPlanParts(deps, await deps.resolveEndpoint());
  const lastMigration = await deps.latestMigration();
  const { inspection } = parts;
  return {
    configPath: deps.location.configPath,
    inspection: {
      status: inspection.status,
      ...(inspection.providerId === undefined ? {} : { providerId: inspection.providerId }),
      ...(inspection.authMode === undefined ? {} : { authMode: inspection.authMode }),
    },
    defaultProviderId: inspection.providerId ?? 'aio-proxy',
    defaultAuthMode: inspection.authMode ?? 'keep-chatgpt',
    occupiedProviderIds: [...parts.occupied],
    keyChoices: parts.keys.choices.map(({ id, label }) => ({ id, label })),
    sessions: {
      groups: parts.sessions.groups.map(({ providerId, active, archived }) => ({ providerId, active, archived })),
      blocked: parts.sessions.blocked.length,
    },
    ...(lastMigration === undefined ? {} : { lastMigrationOperationId: lastMigration }),
    planToken: planToken(parts),
  };
}

/** The wizard's questions, answered from the submitted dashboard form instead of a terminal. */
const presetPrompts = (input: CodexConfigureInput): CodexPrompts => ({
  providerId: async () => input.providerId,
  authMode: async () => input.auth.mode,
  key: async () => (input.auth.mode === 'keep-chatgpt' ? input.auth.key : { kind: 'none' }),
  sources: async () => input.migrateFrom,
  migrate: async () => input.migrateFrom.length > 0,
});

export async function configureCodexFromDashboard(
  submitted: CodexConfigureInput,
  events: { readonly signal: AbortSignal; readonly onDevice: (userCode: string) => void },
  deps: CodexDashboardDeps,
): Promise<CodexConfigureResult> {
  let input: CodexConfigureInput;
  try {
    input = { ...submitted, providerId: validateCodexProviderId(submitted.providerId) };
  } catch {
    throw new AgentOperationError('invalid_provider_id');
  }
  if (await deps.pendingRecovery()) throw new AgentOperationError('recovery_required');
  const endpoint = await deps.resolveEndpoint();
  const parts = await readPlanParts(deps, endpoint);
  if (planToken(parts) !== input.planToken) throw new AgentOperationError('plan_stale');
  if (parts.occupied.includes(input.providerId)) throw new AgentOperationError('occupied_provider_id');
  return runCodexWizard({
    location: deps.location,
    endpoint,
    isTTY: true,
    prompts: presetPrompts(input),
    inspectConfig: async () => parts.inspection,
    occupiedIds: async () => parts.occupied,
    inspectKeys: async () => parts.keys,
    inspectSessions: deps.inspectSessions,
    resolveCommand: deps.resolveCommand,
    resolveEndpoint: deps.resolveEndpoint,
    commitSetup: (selection) =>
      deps.commitSetup(selection, endpoint, {
        signal: events.signal,
        onDevice: async (device) => events.onDevice(device.user_code),
      }),
    migrateSessions: deps.migrateSessions,
  });
}
