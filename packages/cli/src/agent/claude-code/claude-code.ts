import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { acquireProcessFileLock } from '@aio-proxy/core';
import { m } from '@aio-proxy/i18n';
import type { ClaudeCodeSetupPlan } from '@aio-proxy/types';

import { CliExit, EXIT } from '../../exit';
import { canPrompt, openProductionSession, type CommandSession } from '../../ui';
import {
  createCredentialDeps,
  CredentialError,
  inspectProxyKeys,
  probeProxyApiKey,
  type KeyChoice,
  type KeySelection,
  type KeySnapshot,
} from '../codex';
import { resolveAgentEndpoint } from '../control-plane';
import {
  assertClaudeCodeConfigurable,
  configureClaudeCodeSettings,
  inspectClaudeCodeSettings,
  removeClaudeCodeSettings,
  type ClaudeCodeInspection,
  type ClaudeCodeLocation,
} from './managed-settings';

type StaticConfig = { readonly target: 'claude-code'; readonly integration: 'static-config' };

export type ClaudeCodeConfigureResult = StaticConfig & {
  readonly status: 'configured' | 'unchanged';
  readonly configPath: string;
  readonly baseUrl: string;
  readonly credential: 'placeholder' | 'existing';
  readonly connection: 'ok' | 'offline' | 'not_checked';
};

export type ClaudeCodeListResult = StaticConfig & {
  readonly configPath: string;
  readonly status: ClaudeCodeInspection['status'];
  readonly baseUrl?: string;
  readonly credential?: 'placeholder' | 'existing';
  readonly endpointMatches?: boolean;
  readonly connection: 'ok' | 'offline' | 'unauthorized' | 'invalid_response' | 'not_checked';
  readonly changedPaths: readonly string[];
};

export type ClaudeCodeRemoveResult = StaticConfig & {
  readonly configPath: string;
  readonly status: 'removed' | 'partial' | 'absent';
  readonly preservedPaths: readonly string[];
};

export type ClaudeCodeKeySelector = (choices: readonly KeyChoice[]) => Promise<KeySelection>;

export type ClaudeCodeDeps = {
  readonly location: ClaudeCodeLocation;
  readonly detected: () => boolean;
  readonly resolveEndpoint: () => Promise<string>;
  readonly inspectKeys: (endpoint: string) => Promise<KeySnapshot>;
  readonly probe: (endpoint: string, token: string) => Promise<ClaudeCodeListResult['connection']>;
};

/** Global settings only: `CLAUDE_CONFIG_DIR`, else `~/.claude`. Project `.claude/` is never touched. */
export function resolveClaudeCodeLocation(
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): ClaudeCodeLocation {
  const configured = env['CLAUDE_CONFIG_DIR']?.trim();
  const root =
    configured === undefined || configured === ''
      ? join(home, '.claude')
      : configured.startsWith('~/')
        ? join(home, configured.slice(2))
        : configured;
  if (!isAbsolute(root)) throw new Error('Claude Code config directory is not absolute');
  return {
    home: root,
    settingsPath: join(root, 'settings.json'),
    markerPath: join(root, '.aio-proxy', 'claude-code-config.json'),
  };
}

/** PATH first, then where Claude Code's own installers put the binary. */
export function resolveClaudeCodeExecutable(
  which: (command: string) => string | null = Bun.which,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string | undefined {
  return which('claude') ?? [join(home, '.local/bin/claude'), join(home, '.claude/local/claude')].find(exists);
}

export const createClaudeCodeDeps = (
  location: ClaudeCodeLocation = resolveClaudeCodeLocation(process.env),
): ClaudeCodeDeps => ({
  location,
  detected: () => resolveClaudeCodeExecutable() !== undefined,
  resolveEndpoint: resolveAgentEndpoint,
  inspectKeys: (endpoint) => inspectProxyKeys(createCredentialDeps(endpoint)),
  probe: (endpoint, token) => probeProxyApiKey({ endpoint, token }),
});

/**
 * Serializes aio-proxy's own configure and remove runs. Claude Code does not take this lock, so the
 * compare-and-swap in managed-settings still guards against its writes; it cannot exclude one that
 * lands between that check and the rename, the same limit the Codex and Grok Build targets document.
 */
async function withSettingsLock<T>(location: ClaudeCodeLocation, action: () => Promise<T>): Promise<T> {
  const lease = await acquireProcessFileLock(join(location.home, '.aio-proxy.lock'));
  try {
    return await lease.withOwnership(action);
  } finally {
    await lease.release();
  }
}

/**
 * `selectKey` always decides the credential: `none` resolves to the placeholder token only while the
 * proxy has no API keys, and a live key is written only when the caller names it.
 */
export async function configureClaudeCode(
  selectKey: ClaudeCodeKeySelector,
  deps: ClaudeCodeDeps = createClaudeCodeDeps(),
): Promise<ClaudeCodeConfigureResult> {
  if (!deps.detected()) throw new Error('claude-code is not installed');
  await assertClaudeCodeConfigurable(deps.location);
  const endpoint = await deps.resolveEndpoint();
  const keys = await deps.inspectKeys(endpoint);
  const credential = await keys.resolve(await selectKey(keys.choices));
  // Locked only for the write: holding it across the key prompt would block other runs on a human.
  const status = await withSettingsLock(deps.location, async () => {
    // The proxy address can change while the prompt is open; a port-only change passes key validation.
    if ((await deps.resolveEndpoint()) !== endpoint) throw new Error('CLAUDE_CODE_ENDPOINT_CHANGED');
    return configureClaudeCodeSettings(deps.location, {
      endpoint,
      token: credential.token,
      credential: credential.kind,
    });
  });
  return {
    target: 'claude-code',
    integration: 'static-config',
    status,
    configPath: deps.location.settingsPath,
    baseUrl: endpoint,
    credential: credential.kind,
    connection: credential.kind === 'placeholder' ? 'not_checked' : credential.verified ? 'ok' : 'offline',
  };
}

/** The terminal entry: nothing to ask without proxy keys, an explicit choice with them. */
export async function configureClaudeCodeAgent(
  deps: ClaudeCodeDeps = createClaudeCodeDeps(),
): Promise<ClaudeCodeConfigureResult> {
  const ui: { session?: CommandSession } = {};
  let failure: unknown;
  try {
    const result = await configureClaudeCode(async (choices) => {
      if (choices.length === 0) return { kind: 'none' };
      const io = { stdinIsTTY: process.stdin.isTTY === true, stderrIsTTY: process.stderr.isTTY === true };
      if (!canPrompt({ ...io, env: process.env }))
        throw new CliExit(EXIT.unrecoverable, m['cli.agent.claude_code.key_required']());
      ui.session = openProductionSession(m['cli.ui.title_claude_code_configure']());
      const id = await ui.session.select({
        message: m['cli.agent.codex.key_select'](),
        choices: choices.map((choice) => ({ label: choice.label, value: choice.id })),
      });
      return { kind: 'existing', id };
    }, deps);
    ui.session?.finish(m['cli.ui.outro_claude_code_configure']());
    return result;
  } catch (error) {
    failure = error;
    if (error instanceof CredentialError)
      throw new CliExit(EXIT.unrecoverable, m['cli.agent.claude_code.credential_failed']({ code: error.code }));
    if (error instanceof Error && error.message === 'CLAUDE_CODE_ENDPOINT_CHANGED')
      throw new CliExit(EXIT.transient, m['cli.agent.claude_code.endpoint_changed']());
    throw error;
  } finally {
    ui.session?.close(failure);
  }
}

export async function buildClaudeCodeSetupPlan(
  deps: ClaudeCodeDeps = createClaudeCodeDeps(),
): Promise<ClaudeCodeSetupPlan> {
  const keys = await deps.inspectKeys(await deps.resolveEndpoint());
  return {
    configPath: deps.location.settingsPath,
    keyChoices: keys.choices.map(({ id, label }) => ({ id, label })),
  };
}

export async function listClaudeCode(
  check: boolean,
  configuredEndpoint: string | undefined,
  deps: ClaudeCodeDeps = createClaudeCodeDeps(),
): Promise<ClaudeCodeListResult> {
  const { status, endpoint, credential, baseUrl, token, changedPaths } = await inspectClaudeCodeSettings(deps.location);
  const probe = check && status === 'managed' && baseUrl !== undefined && token !== undefined;
  return {
    target: 'claude-code',
    integration: 'static-config',
    configPath: deps.location.settingsPath,
    status,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(credential === undefined ? {} : { credential }),
    ...(endpoint === undefined || configuredEndpoint === undefined
      ? {}
      : { endpointMatches: endpoint === configuredEndpoint }),
    connection: probe ? await deps.probe(baseUrl, token) : 'not_checked',
    changedPaths,
  };
}

export async function removeClaudeCode(deps: ClaudeCodeDeps = createClaudeCodeDeps()): Promise<ClaudeCodeRemoveResult> {
  return {
    target: 'claude-code',
    integration: 'static-config',
    configPath: deps.location.settingsPath,
    // Nothing to remove needs no lock, and must not create the Claude Code directory just to take one.
    ...((await Bun.file(deps.location.markerPath).exists())
      ? await withSettingsLock(deps.location, () => removeClaudeCodeSettings(deps.location))
      : { status: 'absent' as const, preservedPaths: [] }),
  };
}
