import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { m } from '@aio-proxy/i18n';

import { CliExit, EXIT } from '../../exit';
import { canPrompt, openProductionSession, type CommandSession } from '../../ui';
import { formatAgentToken } from '../command-auth/token-output';
import { resolveAgentEndpoint } from '../control-plane';
import { isCodexCancellation } from './cancellation';
import { writeCodexAuthToken } from './command-auth';
import { resolveCodexAuthCommand } from './command-location';
import { validateCodexProviderId } from './config-document';
import type { CodexLocation, CodexListResult, CodexRemoveResult } from './contracts';
import { inspectProxyKeys, probeProxyApiKey } from './credentials';
import { listCodexLifecycle, removeCodexLifecycle } from './lifecycle';
import { inspectCodexConfig, recoverCodexConfigOperation } from './managed-config';
import { authContext, configuredLocation, createCredentialDeps, occupiedIds, restoreMigrationResult } from './runtime';
import { inspectCodexSessions, isCodexUuid, migrateCodexSessions } from './sessions';
import { commitCodexSetup, recoverCodexAuthOperation } from './setup';
import { assertCodexSetupEndpoint, runCodexWizard, type CodexConfigureResult, type CodexPrompts } from './wizard';

export type { CodexConfigureResult } from './wizard';

export type { CodexListResult, CodexRemoveResult } from './contracts';

export type CodexConfigureOptions = { readonly restoreMigration?: string };

const missingCodex = (): CliExit => new CliExit(EXIT.unrecoverable, m['cli.agent.codex.not_installed']());

/** PATH first, then the Codex binary shipped inside the ChatGPT app. */
export function resolveCodexExecutable(
  which: (command: string) => string | null = Bun.which,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string | undefined {
  const onPath = which('codex');
  if (onPath !== null) return onPath;
  const bundled = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    join(home, 'Applications/ChatGPT.app/Contents/Resources/codex'),
  ];
  return bundled.find((path) => exists(path));
}

const checkCodexInstalled = async (): Promise<string> => {
  const executable = resolveCodexExecutable();
  if (executable === undefined) throw missingCodex();
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([executable, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  } catch {
    throw missingCodex();
  }
  const output = await new Response(child.stdout as ReadableStream<Uint8Array>).text();
  const exit = await child.exited;
  const version = output.match(/^codex-cli\s+(\d+\.\d+\.\d+)\b/m)?.[1];
  if (exit !== 0 || version === undefined) throw missingCodex();
  return version;
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

const createPrompts = (session: CommandSession): CodexPrompts => ({
  providerId: async (defaultId, occupied) => {
    let message: string = m['cli.agent.codex.provider_id']();
    for (;;) {
      const value = await session.prompts.input({ message, defaultValue: defaultId });
      try {
        const id = validateCodexProviderId(value);
        if (occupied.includes(id)) {
          message = `${m['cli.agent.codex.provider_id']()}\n${m['cli.agent.codex.provider_conflict']({ providerId: id })}`;
          continue;
        }
        return id;
      } catch {
        message = `${m['cli.agent.codex.provider_id']()}\n${m['cli.agent.codex.provider_id_invalid']()}`;
      }
    }
  },
  authMode: (defaultMode) =>
    session.select({
      message: m['cli.agent.codex.auth_mode'](),
      initialValue: defaultMode,
      choices: [
        {
          value: 'keep-chatgpt' as const,
          label: m['cli.agent.codex.auth_keep'](),
          hint: m['cli.agent.codex.auth_keep_explanation'](),
        },
        {
          value: 'command' as const,
          label: m['cli.agent.codex.auth_command'](),
          hint: m['cli.agent.codex.auth_command_explanation'](),
        },
      ],
    }),
  key: async (choices) => {
    const value = await session.select({
      message: m['cli.agent.codex.key_select'](),
      choices: choices.map((choice) => ({ label: choice.label, value: choice.id })),
    });
    return { kind: 'existing', id: value };
  },
  sources: async (groups, previous) => {
    let message: string = m['cli.agent.codex.sources']();
    for (;;) {
      const values = await session.multiselect({
        message,
        choices: groups.map((group) => ({
          value: group.providerId,
          label: `${group.providerId} (${group.active} active, ${group.archived} archived)`,
        })),
        ...(previous === '' ? {} : { initialValues: [previous] }),
      });
      if (values.length > 0) return values;
      message = `${m['cli.agent.codex.sources']()}\n${m['cli.agent.codex.sources_required']()}`;
    }
  },
  migrate: ({ sources, target, active, archived }) =>
    session.confirm({
      message: `${m['cli.agent.codex.migrate_explanation']()}\n${m['cli.agent.codex.migrate']({
        sources: sources.join(', '),
        target,
        active: String(active),
        archived: String(archived),
      })}`,
      initialValue: false,
    }),
});

const connectionStatus = async (baseUrl?: string, token?: string): Promise<CodexListResult['connection']> => {
  if (baseUrl === undefined) return 'offline';
  if (token === undefined || token.length === 0) return 'unauthorized';
  const endpoint = baseUrl.replace(/\/v1\/?$/u, '').replace(/\/+$/u, '');
  return probeProxyApiKey({ endpoint, token });
};

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
  if (options.restoreMigration !== undefined) return restoreMigrationResult(location, options.restoreMigration);
  const interactive = canPrompt({
    stdinIsTTY: process.stdin.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    env: process.env,
  });
  if (!interactive) return cancelledCodexResult(location, 'non_interactive');
  const version = await checkCodexInstalled();
  const endpoint = await resolveAgentEndpoint();
  const currentEndpoint = async (): Promise<string> => {
    const current = await resolveAgentEndpoint();
    assertCodexSetupEndpoint(endpoint, current);
    return current;
  };
  const authOperation = await import('./setup/journal').then(({ readAuthOperation }) => readAuthOperation(location));
  const session = openProductionSession(m['cli.ui.title_codex_configure']());
  let failure: unknown;
  try {
    const confirmRecovery = (): Promise<boolean> =>
      session.confirm({ message: m['cli.agent.codex.pending_recovery'](), initialValue: false });
    const recovery = await recoverPendingCodexOperations(
      (confirm) => recoverCodexConfigOperation(location, confirm),
      authOperation !== undefined,
      confirmRecovery,
      async () => recoverCodexAuthOperation(authContext(location, await currentEndpoint()), 'complete'),
    );
    if (recovery === 'cancelled') return cancelledCodexResult(location);
    const result = await runCodexWizard({
      location,
      endpoint,
      isTTY: true,
      prompts: createPrompts(session),
      inspectConfig: () => inspectCodexConfig(location),
      occupiedIds: () => occupiedIds(location),
      inspectKeys: async () => {
        const keys = await inspectProxyKeys(createCredentialDeps(endpoint));
        if (keys.choices.length === 0) session.note(m['cli.agent.codex.key_none']());
        return keys;
      },
      inspectSessions: (providerId) =>
        session.spin(m['cli.agent.codex.sessions_loading'](), (signal) =>
          inspectCodexSessions(location, providerId, signal),
        ),
      resolveCommand: resolveCodexAuthCommand,
      resolveEndpoint: resolveAgentEndpoint,
      commitSetup: async (selection) => commitCodexSetup(selection, authContext(location, await currentEndpoint())),
      migrateSessions: (targets, providerId) =>
        migrateCodexSessions({ location, targets, targetProviderId: providerId }),
    });
    if (result.status === 'cancelled') return result;
    session.finish(m['cli.ui.outro_codex_configure']());
    return { ...result, version, versionCompatibility: 'unverified' as const };
  } catch (error) {
    if (isCodexCancellation(error)) return cancelledCodexResult(location);
    failure = error;
    throw error;
  } finally {
    session.close(failure);
  }
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
  if (!isCodexUuid(installationId)) throw new Error('Codex installation id must be a UUID');
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
