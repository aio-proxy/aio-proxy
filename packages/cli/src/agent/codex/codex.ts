import { homedir } from 'node:os';
import { join } from 'node:path';

import { AtomicConfigFile, configPath } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import { checkbox, confirm, input, select } from '@inquirer/prompts';

import packageJson from '../../../package.json' with { type: 'json' };
import { readServiceEnvironment } from '../../service-env';
import { formatAgentToken } from '../command-auth/token-output';
import { resolveAgentEndpoint } from '../control-plane';
import { writeCodexAuthToken } from './command-auth';
import { resolveCodexAuthCommand } from './command-location';
import { readCodexDocument, validateCodexProviderId } from './config-document';
import type { CodexLocation, CodexListResult, CodexRemoveResult } from './contracts';
import { inspectProxyKeys, probeProxyApiKey } from './credentials';
import { listCodexLifecycle, removeCodexLifecycle } from './lifecycle';
import { resolveCodexLocation } from './location';
import { inspectCodexConfig, recoverCodexConfigOperation } from './managed-config';
import { inspectCodexSessions, migrateCodexSessions, restoreCodexMigration } from './sessions';
import { commitCodexSetup, recoverCodexAuthOperation } from './setup';
import { assertCodexSetupEndpoint, runCodexWizard, type CodexConfigureResult, type CodexPrompts } from './wizard';

export type { CodexConfigureResult } from './wizard';

export type { CodexListResult, CodexRemoveResult } from './contracts';

export type CodexConfigureOptions = { readonly restoreMigration?: string };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const checkCodexInstalled = async (): Promise<string> => {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(['codex', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    throw new Error('Codex installation is missing');
  }
  const output = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
  const exit = await child.exited;
  const version = output.match(/^codex-cli\s+(\d+\.\d+\.\d+)\b/m)?.[1];
  if (exit !== 0 || version === undefined) {
    throw new Error('Codex installation is missing');
  }
  return version;
};

const isPromptCancellation = (error: unknown): boolean => {
  if (error === null || typeof error !== 'object') return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return /abort|(?:cancel|exit)prompt|(?:cancelled|canceled)/iu.test(`${name} ${message}`);
};

const cancelledCodexResult = (location: CodexLocation, reason?: 'non_interactive'): CodexConfigureResult => ({
  target: 'codex',
  integration: 'static-config',
  status: 'cancelled',
  configPath: location.configPath,
  connection: 'not_checked',
  credential: 'none',
  migration: { status: 'not_requested' },
  ...(reason === undefined ? {} : { reason }),
});

const configuredLocation = (): CodexLocation => resolveCodexLocation(join(homedir(), '.codex'), process.env);

const occupiedIds = async (location: CodexLocation): Promise<readonly string[]> => {
  try {
    const config = await Bun.file(location.configPath).text();
    const ids = readCodexDocument(config).providerIds;
    const managed = (await inspectCodexConfig(location)).providerId;
    return ids.filter((id) => id !== managed);
  } catch {
    return [];
  }
};

const createCredentialDeps = (endpoint: string) => {
  const path = configPath();
  const file = new AtomicConfigFile(path);
  return {
    file,
    loadEnvironment() {},
    readEnvironment: () => readServiceEnvironment(path),
    check: (token: string) => probeProxyApiKey({ endpoint, token }),
  };
};

const createPrompts = (): CodexPrompts => ({
  providerId: async (defaultId, occupied) =>
    input({
      message: m['cli.agent.codex.provider_id'](),
      default: defaultId,
      validate: (value) => {
        try {
          const id = validateCodexProviderId(value);
          if (occupied.includes(id)) return m['cli.agent.codex.provider_conflict']({ providerId: id });
          return true;
        } catch {
          return m['cli.agent.codex.provider_id_invalid']();
        }
      },
    }),
  authMode: async (defaultMode) => {
    const value = await select({
      message: m['cli.agent.codex.auth_mode'](),
      default: defaultMode,
      choices: [
        {
          value: 'keep-chatgpt' as const,
          name: m['cli.agent.codex.auth_keep'](),
          description: m['cli.agent.codex.auth_keep_explanation'](),
        },
        {
          value: 'command' as const,
          name: m['cli.agent.codex.auth_command'](),
          description: m['cli.agent.codex.auth_command_explanation'](),
        },
      ],
    });
    return value;
  },
  key: async (choices) => {
    const value = await select({
      message: m['cli.agent.codex.key_select'](),
      choices: choices.map((choice) => ({ value: choice.id, name: choice.label })),
    });
    return { kind: 'existing', id: value };
  },
  sources: async (groups, previous) =>
    checkbox({
      message: m['cli.agent.codex.sources'](),
      choices: groups.map((group) => ({
        value: group.providerId,
        name: `${group.providerId} (${group.active} active, ${group.archived} archived)`,
        checked: group.providerId === previous,
      })),
      validate: (values) => (values.length > 0 ? true : m['cli.agent.codex.sources_required']()),
    }),
  migrate: async ({ sources, target, active, archived }) =>
    confirm({
      message: `${m['cli.agent.codex.migrate_explanation']()}\n${m['cli.agent.codex.migrate']({
        sources: sources.join(', '),
        target,
        active: String(active),
        archived: String(archived),
      })}`,
      default: false,
    }),
});

const authSignal = (): AbortSignal => AbortSignal.timeout(600_000);

const connectionStatus = async (baseUrl?: string, token?: string): Promise<CodexListResult['connection']> => {
  if (baseUrl === undefined) return 'offline';
  if (token === undefined || token.length === 0) return 'unauthorized';
  const endpoint = baseUrl.replace(/\/v1\/?$/u, '').replace(/\/+$/u, '');
  return probeProxyApiKey({ endpoint, token });
};

const authContext = (location: CodexLocation, endpoint: string) => ({
  location,
  endpoint,
  adapterVersion: packageJson.version,
  signal: authSignal(),
  onDevice: async (device: import('@aio-proxy/types').AgentDeviceCodeResponse): Promise<void> => {
    console.error(
      m['cli.agent.codex.device_authorization']({
        url: device.verification_uri_complete,
        code: device.user_code,
      }),
    );
  },
  revoke: (boundEndpoint: string, installationId: string) =>
    import('../control-plane').then(({ revokeAgentInstallation }) =>
      revokeAgentInstallation(boundEndpoint, installationId),
    ),
});

const pendingRecovery = async (message: () => string): Promise<boolean> =>
  confirm({ message: message(), default: false });

export async function recoverPendingCodexOperations(
  recoverConfig: (
    confirmRecovery: () => Promise<boolean>,
  ) => Promise<Awaited<ReturnType<typeof recoverCodexConfigOperation>>>,
  hasAuthOperation: boolean,
  confirmRecovery: () => Promise<boolean>,
  recoverAuth: () => Promise<'none' | 'completed' | 'blocked'>,
): Promise<'continue' | 'cancelled'> {
  const configRecovery = await recoverConfig(confirmRecovery);
  if (configRecovery === 'declined') return 'cancelled';
  if (hasAuthOperation) {
    if (!(await confirmRecovery())) return 'cancelled';
    if ((await recoverAuth()) === 'blocked') throw new Error('Codex authentication operation requires recovery');
  }
  return 'continue';
}

export async function configureCodexAgent(options: CodexConfigureOptions = {}): Promise<CodexConfigureResult> {
  const location = configuredLocation();
  if (options.restoreMigration !== undefined) {
    if (!uuidPattern.test(options.restoreMigration)) throw new Error('migration operation id must be a UUID');
    const migration = await restoreCodexMigration(location, options.restoreMigration);
    return {
      target: 'codex',
      integration: 'static-config',
      status: 'unchanged',
      configPath: location.configPath,
      connection: 'not_checked',
      credential: 'none',
      migration,
      migrationAction: 'restore',
    };
  }
  const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!isTTY) return cancelledCodexResult(location, 'non_interactive');
  const version = await checkCodexInstalled();
  const endpoint = await resolveAgentEndpoint();
  const currentEndpoint = async (): Promise<string> => {
    const current = await resolveAgentEndpoint();
    assertCodexSetupEndpoint(endpoint, current);
    return current;
  };
  const authOperation = await import('./setup/journal').then(({ readAuthOperation }) => readAuthOperation(location));
  const confirmRecovery = async (): Promise<boolean> => {
    return pendingRecovery(() => m['cli.agent.codex.pending_recovery']());
  };
  try {
    const recovery = await recoverPendingCodexOperations(
      (confirm) => recoverCodexConfigOperation(location, confirm),
      authOperation !== undefined,
      confirmRecovery,
      async () => recoverCodexAuthOperation(authContext(location, await currentEndpoint()), 'complete'),
    );
    if (recovery === 'cancelled') return cancelledCodexResult(location);
  } catch (error) {
    if (isPromptCancellation(error)) return cancelledCodexResult(location);
    throw error;
  }
  const result = await runCodexWizard({
    location,
    endpoint,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompts: createPrompts(),
    inspectConfig: () => inspectCodexConfig(location),
    occupiedIds: () => occupiedIds(location),
    inspectKeys: async () => {
      const keys = await inspectProxyKeys(createCredentialDeps(endpoint));
      if (keys.choices.length === 0) console.error(m['cli.agent.codex.key_none']());
      return keys;
    },
    inspectSessions: (providerId) => inspectCodexSessions(location, providerId),
    resolveCommand: resolveCodexAuthCommand,
    resolveEndpoint: resolveAgentEndpoint,
    commitSetup: async (selection) => commitCodexSetup(selection, authContext(location, await currentEndpoint())),
    migrateSessions: (targets, providerId) => migrateCodexSessions({ location, targets, targetProviderId: providerId }),
  });
  return result.status === 'cancelled' ? result : { ...result, version, versionCompatibility: 'unverified' as const };
}

export async function listCodexAgent(check = false): Promise<CodexListResult> {
  const location = configuredLocation();
  return listCodexLifecycle({
    location,
    check,
    checkStatic: connectionStatus,
  });
}

export async function removeCodexAgent(): Promise<CodexRemoveResult> {
  const location = configuredLocation();
  return removeCodexLifecycle({
    location,
    revoke: (endpoint, installationId) =>
      import('../control-plane').then(({ revokeAgentInstallation }) =>
        revokeAgentInstallation(endpoint, installationId),
      ),
  });
}

const helperProcessStartedAt = (): number => Date.now() - process.uptime() * 1_000;

export async function runCodexAuthCommand(
  installationId: string,
  startedAt = helperProcessStartedAt(),
  writeToken: (token: string) => Promise<void> = (token) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(formatAgentToken({ accessToken: token, expiresIn: 0 }, 'raw'), (error) =>
        error === undefined ? resolve() : reject(error),
      );
    }),
): Promise<void> {
  if (!uuidPattern.test(installationId)) throw new Error('Codex installation id must be a UUID');
  const remainingMs = Math.max(0, 4_500 - (Date.now() - startedAt));
  if (remainingMs === 0) throw new Error('CODEX_AUTH_TIMEOUT');
  const location = configuredLocation();
  await writeCodexAuthToken({
    location,
    installationId,
    signal: AbortSignal.timeout(remainingMs),
    writeToken,
  });
}
