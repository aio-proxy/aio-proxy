import { AgentOperationError, type AgentHostPort } from '@aio-proxy/server';
import {
  agentDescriptor,
  type AgentLocalState,
  type AgentLocalStatus,
  type AgentOperationErrorCode,
  type AgentOperationResult,
  type AgentTarget,
} from '@aio-proxy/types';

import { agentConfigure, agentRemove, commandDeps, type AgentCommandDeps, type AgentListTargetResult } from '../agent';
import {
  buildCodexSetupPlan,
  configureCodexFromDashboard,
  createCodexDashboardDeps,
  resolveCodexExecutable,
  restoreMigrationResult,
  type CodexConfigureResult,
  type CodexDashboardDeps,
  type CodexListResult,
} from '../codex';
import { agentList } from '../list';

export type AgentHostPortDeps = {
  readonly command: AgentCommandDeps;
  readonly codex: () => CodexDashboardDeps;
  readonly codexDetected: () => boolean;
};

const ERROR_MESSAGES: ReadonlyArray<readonly [RegExp, AgentOperationErrorCode]> = [
  [/ is not installed$/u, 'host_missing'],
  [/^managed installation is required$/u, 'not_configured'],
  [/^CODEX_(SETUP_ENDPOINT_CHANGED|AUTH_ENDPOINT_OR_PROVIDER_CHANGED)$/u, 'endpoint_changed'],
  [/^CODEX_AUTH_OPERATION_PENDING$/u, 'recovery_required'],
  [/operation is pending$|lock/iu, 'locked'],
  [/ is occupied$/u, 'occupied_provider_id'],
];

/** Maps the CLI's existing failures onto the dashboard's closed error codes. */
export function classifyAgentError(error: unknown): AgentOperationError | undefined {
  if (error instanceof AgentOperationError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'access_denied') return new AgentOperationError('authorization_denied');
  if (code === 'expired_token') return new AgentOperationError('authorization_expired');
  if (!(error instanceof Error)) return undefined;
  const match = ERROR_MESSAGES.find(([pattern]) => pattern.test(error.message));
  return match === undefined ? undefined : new AgentOperationError(match[1]);
}

const classified = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw classifyAgentError(error) ?? error;
  }
};

const isOlder = (version: string, current: string): boolean => {
  try {
    return Bun.semver.order(version, current) < 0;
  } catch {
    return false;
  }
};

const pluginStatus = (row: AgentListTargetResult, adapterVersion: string): AgentLocalStatus => {
  if (!row.host.detected) return 'not_installed';
  if (row.integration === 'unresolved' || row.integration === 'conflict') return 'conflict';
  if (row.integration === 'absent') return 'not_configured';
  if ('configuration' in row) {
    if (row.integration === 'newer' || row.configuration === 'current')
      return row.marker !== undefined && isOlder(row.marker.adapterVersion, adapterVersion) ? 'outdated' : 'configured';
    return row.configuration;
  }
  if (row.entry === 'missing') return 'missing';
  return row.marker !== undefined && isOlder(row.marker.adapterVersion, adapterVersion) ? 'outdated' : 'configured';
};

const codexStatus = (codex: CodexListResult, detected: boolean, recovery: boolean): AgentLocalStatus => {
  if (recovery) return 'recovery_required';
  if (codex.status === 'absent') return detected ? 'not_configured' : 'not_installed';
  return codex.status === 'managed' ? 'configured' : codex.status;
};

const configPathOf = async (target: AgentTarget, deps: AgentCommandDeps): Promise<string | undefined> => {
  try {
    const location = await deps.resolveLocation(target);
    return target === 'grok' ? location.hostRoot : location.managedDir;
  } catch {
    return undefined;
  }
};

async function inspectLocal(deps: AgentHostPortDeps): Promise<readonly AgentLocalState[]> {
  const list = await agentList({ check: false }, deps.command);
  const rows: AgentLocalState[] = [];
  for (const row of list.targets) {
    const marker = row.integration === 'managed' || row.integration === 'newer' ? row.marker : undefined;
    const configPath = row.host.detected ? await configPathOf(row.target, deps.command) : undefined;
    const endpointMatches = 'endpointMatches' in row ? row.endpointMatches : undefined;
    rows.push({
      target: row.target,
      host: {
        detected: row.host.detected,
        ...(row.host.version === undefined ? {} : { version: row.host.version }),
        support: row.host.support,
      },
      status: pluginStatus(row, deps.command.adapterVersion),
      ...(configPath === undefined ? {} : { configPath }),
      ...(marker === undefined ? {} : { installationId: marker.installationId, adapterVersion: marker.adapterVersion }),
      ...(endpointMatches === undefined ? {} : { endpointMatches }),
    });
  }
  const codex = deps.codex();
  const detected = deps.codexDetected();
  const recovery = await codex.pendingRecovery().catch(() => false);
  rows.push({
    target: 'codex',
    host: { detected, support: 'unknown' },
    status: codexStatus(list.codex, detected, recovery),
    configPath: list.codex.configPath,
    ...(list.codex.installationId === undefined ? {} : { installationId: list.codex.installationId }),
    codex: {
      ...(list.codex.providerId === undefined ? {} : { providerId: list.codex.providerId }),
      ...(list.codex.authMode === undefined ? {} : { authMode: list.codex.authMode }),
    },
  });
  const order = new Map(['opencode', 'pi', 'omp', 'codex', 'grok'].map((target, index) => [target, index]));
  return rows.sort((left, right) => order.get(left.target)! - order.get(right.target)!);
}

const codexResult = (result: CodexConfigureResult): AgentOperationResult => {
  const { migration } = result;
  return {
    target: 'codex',
    status: result.status,
    configPath: result.configPath,
    ...(result.providerId === undefined ? {} : { providerId: result.providerId }),
    ...(result.authMode === undefined ? {} : { authMode: result.authMode }),
    ...(result.installationId === undefined ? {} : { installationId: result.installationId }),
    migration: {
      status: migration.status,
      ...('migrated' in migration
        ? {
            migrated: migration.migrated,
            skipped: migration.skipped,
            conflicts: migration.conflicts,
            ...(migration.operationId === undefined ? {} : { operationId: migration.operationId }),
          }
        : {}),
    },
  };
};

export function createAgentHostPort(
  deps: AgentHostPortDeps = {
    command: commandDeps(),
    codex: () => createCodexDashboardDeps(),
    codexDetected: () => resolveCodexExecutable() !== undefined,
  },
): AgentHostPort {
  const inspect = () => inspectLocal(deps);
  const requireCodex = (): void => {
    if (!deps.codexDetected()) throw new AgentOperationError('host_missing');
  };
  return {
    inspect,
    configure: (target, codex, events) =>
      classified(async () => {
        if (target === 'codex') {
          requireCodex();
          if (codex === undefined) throw new AgentOperationError('unknown');
          const result = await configureCodexFromDashboard(
            codex,
            { signal: events.signal, onDevice: (userCode) => events.onDevice({ userCode }) },
            deps.codex(),
          );
          return codexResult(result);
        }
        const result = await agentConfigure(target, deps.command);
        const installationId = (await inspect()).find((row) => row.target === target)?.installationId;
        const configPath = await configPathOf(target, deps.command);
        return {
          target,
          status: 'status' in result ? result.status : 'configured',
          ...(installationId === undefined ? {} : { installationId }),
          ...(configPath === undefined ? {} : { configPath }),
          ...(agentDescriptor(target).loginCommand === undefined
            ? {}
            : { loginCommand: agentDescriptor(target).loginCommand }),
        } satisfies AgentOperationResult;
      }),
    remove: (target) =>
      classified(async () => {
        const result = await agentRemove(target, deps.command);
        if ('revokeStatus' in result)
          return {
            target,
            status: 'removed',
            installationId: result.installationId,
            revokeStatus: result.revokeStatus,
            ...('skippedFields' in result && result.skippedFields !== undefined
              ? { skippedFields: [...result.skippedFields] }
              : {}),
            ...('retainedFiles' in result && result.retainedFiles !== undefined
              ? { retainedFiles: [...result.retainedFiles] }
              : {}),
          };
        return {
          target: 'codex',
          status: result.status,
          configPath: result.configPath,
          preservedPaths: result.preservedPaths.map((path) => path.join('.')),
          ...(result.authorization === undefined ? {} : { revokeStatus: result.authorization }),
        };
      }),
    codexPlan: () =>
      classified(async () => {
        requireCodex();
        return buildCodexSetupPlan(deps.codex());
      }),
    restoreCodexMigration: (operationId) =>
      classified(async () => codexResult(await restoreMigrationResult(deps.codex().location, operationId))),
  };
}
