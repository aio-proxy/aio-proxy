import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';

import { AtomicConfigFile, configPath } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import { checkbox, confirm, input, select } from '@inquirer/prompts';

import { reloadCommand } from '../../reload';
import { loadServiceEnv } from '../../service-env';
import { codexBaseUrl, resolveAgentEndpoint } from '../control-plane';
import { readCodexDocument, validateCodexProviderId } from './config-document';
import type { ConfigInspection, CodexLocation } from './contracts';
import { inspectProxyKeys } from './credentials';
import { resolveCodexLocation } from './location';
import {
  configureCodexConfig,
  inspectCodexConfig,
  recoverCodexConfigOperation,
  removeCodexConfig,
} from './managed-config';
import { inspectCodexSessions, migrateCodexSessions, restoreCodexMigration } from './sessions';
import { runCodexWizard, type CodexConfigureResult, type CodexPrompts } from './wizard';

export type { CodexConfigureResult } from './wizard';

export type CodexListResult = {
  readonly target: 'codex';
  readonly integration: 'static-config';
  readonly configPath: string;
  readonly providerId?: string;
  readonly activeProviderId: string;
  readonly baseUrl?: string;
  readonly status: ConfigInspection['status'];
  readonly connection: 'ok' | 'offline' | 'unauthorized' | 'invalid_response' | 'not_checked';
  readonly changedPaths: readonly (readonly string[])[];
};

export type CodexRemoveResult = {
  readonly target: 'codex';
  readonly integration: 'static-config';
  readonly configPath: string;
  readonly keysRetained: true;
  readonly status: 'removed' | 'partial' | 'absent';
  readonly preservedPaths: readonly (readonly string[])[];
};

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

const isPromptCancellation = (error: unknown): boolean =>
  error instanceof Error &&
  /(?:abort|cancel|exit)prompt|(?:cancelled|canceled)/iu.test(`${error.name} ${error.message}`);

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

const configuredLocation = (): CodexLocation => resolveCodexLocation(homedir(), process.env);

const occupiedIds = async (location: CodexLocation): Promise<readonly string[]> => {
  try {
    const config = await readFile(location.configPath, 'utf8');
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
    endpoint,
    loadEnvironment: () => loadServiceEnv(path),
    readEnvironment: () => ({ ...process.env }),
    randomKey: () => `sk-${crypto.randomUUID().replaceAll('-', '')}`,
    reload: () => reloadCommand(),
    check: async (token: string): Promise<'ok' | 'offline' | 'unauthorized' | 'invalid_response'> => {
      try {
        const response = await fetch(`${endpoint.replace(/\/+$/u, '')}/health`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(3_000),
        });
        if (response.status === 401 || response.status === 403) return 'unauthorized';
        if (!response.ok) return response.status >= 500 ? 'offline' : 'invalid_response';
        return 'ok';
      } catch {
        return 'offline';
      }
    },
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
  key: async (choices) => {
    const value = await select({
      message: m['cli.agent.codex.key_select'](),
      choices: [
        ...choices.map((choice) => ({ value: choice.id, name: choice.label })),
        { value: 'new', name: m['cli.agent.codex.key_new']() },
      ],
    });
    return value === 'new' ? { kind: 'new' } : { kind: 'existing', id: value };
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

const connectionStatus = async (endpoint: string): Promise<CodexListResult['connection']> => {
  try {
    const response = await fetch(`${endpoint.replace(/\/+$/u, '')}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (response.status === 401 || response.status === 403) return 'unauthorized';
    if (!response.ok) return response.status >= 500 ? 'offline' : 'invalid_response';
    const body: unknown = await response.json().catch(() => undefined);
    if (typeof body !== 'object' || body === null || (body as { readonly status?: unknown }).status !== 'ok')
      return 'invalid_response';
    return 'ok';
  } catch {
    return 'offline';
  }
};

const resolveEndpointSafely = async (): Promise<string | undefined> => {
  try {
    return await resolveAgentEndpoint();
  } catch {
    return undefined;
  }
};

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
  let recovery: Awaited<ReturnType<typeof recoverCodexConfigOperation>>;
  try {
    recovery = await recoverCodexConfigOperation(location, async () =>
      confirm({ message: m['cli.agent.codex.pending_recovery'](), default: false }),
    );
  } catch (error) {
    if (isPromptCancellation(error)) return cancelledCodexResult(location);
    throw error;
  }
  if (recovery === 'declined') {
    return {
      target: 'codex',
      integration: 'static-config',
      status: 'cancelled',
      configPath: location.configPath,
      connection: 'not_checked',
      credential: 'none',
      migration: { status: 'not_requested' },
    };
  }
  const endpoint = await resolveAgentEndpoint();
  const result = await runCodexWizard({
    location,
    endpoint,
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompts: createPrompts(),
    inspectConfig: () => inspectCodexConfig(location),
    occupiedIds: () => occupiedIds(location),
    inspectKeys: () => inspectProxyKeys(createCredentialDeps(endpoint)),
    inspectSessions: (providerId) => inspectCodexSessions(location, providerId),
    saveConfig: (providerId, token) =>
      configureCodexConfig({ location, providerId, baseUrl: codexBaseUrl(endpoint), token }),
    migrateSessions: (targets, providerId) => migrateCodexSessions({ location, targets, targetProviderId: providerId }),
  });
  return result.status === 'cancelled' ? result : { ...result, version, versionCompatibility: 'unverified' as const };
}

export async function listCodexAgent(check = false): Promise<CodexListResult> {
  const location = configuredLocation();
  const inspection = await inspectCodexConfig(location);
  const endpoint = check ? await resolveEndpointSafely() : undefined;
  return {
    target: 'codex',
    integration: 'static-config',
    configPath: location.configPath,
    ...(inspection.providerId === undefined ? {} : { providerId: inspection.providerId }),
    activeProviderId: inspection.activeProviderId,
    ...(inspection.baseUrl === undefined ? {} : { baseUrl: inspection.baseUrl }),
    status: inspection.status,
    connection: check ? (endpoint === undefined ? 'offline' : await connectionStatus(endpoint)) : 'not_checked',
    changedPaths: inspection.changedPaths,
  };
}

export async function removeCodexAgent(): Promise<CodexRemoveResult> {
  const location = configuredLocation();
  const result = await removeCodexConfig(location);
  return {
    target: 'codex',
    integration: 'static-config',
    configPath: location.configPath,
    keysRetained: true,
    ...result,
  };
}
