import type { AgentRevokeStatus } from '@aio-proxy/types';

import {
  clearCodexCommandInstallation,
  inspectCodexCommandCredential,
  readCodexCommandCredentialInstallationId,
  readCodexCommandIdentity,
  retireCodexCommandInstallation,
} from '../command-auth';
import type { CodexListResult, CodexLocation, CodexRemoveResult } from '../contracts';
import { inspectCodexConfig, removeCodexConfig } from '../managed-config';
import { clearAuthOperation, writeAuthOperation } from '../setup/journal';
import { withCodexInstallation } from '../storage/installation-lock';

export type CodexLifecycleDeps = {
  readonly location: CodexLocation;
  readonly endpoint?: string;
  readonly signal?: AbortSignal;
  readonly checkStatic?: () => Promise<CodexListResult['connection']>;
  readonly revoke?: (endpoint: string, installationId: string) => Promise<AgentRevokeStatus>;
};

const terminalRevocations = new Set<AgentRevokeStatus>(['revoked', 'expired', 'missing']);

const defaultSignal = (): AbortSignal => AbortSignal.timeout(15_000);

const authorizationFromCredential = (
  check: boolean,
  credential:
    | {
        readonly credentialStatus: 'missing' | 'ready' | 'expired' | 'reauthorize';
        readonly connection: 'ok' | 'offline' | 'unauthorized' | 'invalid_response' | 'not_checked';
      }
    | undefined,
): CodexListResult['authorization'] => {
  if (!check || credential === undefined) return 'not_checked';
  if (credential.credentialStatus === 'missing') return 'missing';
  if (credential.credentialStatus === 'expired') return 'expired';
  if (credential.connection === 'ok') return 'active';
  if (credential.connection === 'unauthorized') return 'revoked';
  return 'not_checked';
};

export async function listCodexLifecycle(
  input: CodexLifecycleDeps & { readonly check: boolean },
): Promise<CodexListResult> {
  const inspection = await inspectCodexConfig(input.location);
  const identity = await readCodexCommandIdentity(input.location).catch(() => undefined);
  const credential =
    identity === undefined
      ? undefined
      : await inspectCodexCommandCredential({
          location: input.location,
          check: input.check,
          signal: input.signal ?? defaultSignal(),
        }).catch(() => ({ credentialStatus: 'reauthorize' as const, connection: 'not_checked' as const }));
  const authMode = inspection.authMode ?? (identity === undefined ? undefined : 'command');
  const connection =
    input.check && identity === undefined && authMode === 'keep-chatgpt'
      ? ((await input.checkStatic?.()) ?? 'not_checked')
      : input.check
        ? (credential?.connection ?? 'not_checked')
        : 'not_checked';
  const result: CodexListResult = {
    target: 'codex',
    integration: 'static-config',
    configPath: input.location.configPath,
    ...(inspection.providerId === undefined && identity?.providerId === undefined
      ? {}
      : { providerId: inspection.providerId ?? identity?.providerId }),
    activeProviderId: inspection.activeProviderId,
    ...(inspection.baseUrl === undefined ? {} : { baseUrl: inspection.baseUrl }),
    status: inspection.status,
    connection,
    ...(authMode === undefined ? {} : { authMode }),
    ...(inspection.installationId === undefined && identity?.marker.installationId === undefined
      ? {}
      : { installationId: inspection.installationId ?? identity?.marker.installationId }),
    ...(identity === undefined ? {} : { lifecycle: identity.status }),
    ...(credential === undefined ? {} : { credentialStatus: credential.credentialStatus }),
    changedPaths: inspection.changedPaths,
  };
  return identity === undefined
    ? result
    : { ...result, authorization: authorizationFromCredential(input.check, credential) };
}

export async function removeCodexLifecycle(input: CodexLifecycleDeps): Promise<CodexRemoveResult> {
  const signal = input.signal ?? defaultSignal();
  return withCodexInstallation(input.location, signal, async (lease) => {
    const inspection = await inspectCodexConfig(input.location);
    const identity = await readCodexCommandIdentity(input.location).catch(() => undefined);
    const credentialInstallationId = await readCodexCommandCredentialInstallationId(input.location);
    const providerId = inspection.providerId ?? identity?.providerId ?? 'aio-proxy';
    let authorization: CodexRemoveResult['authorization'];
    const installationId = identity?.marker.installationId ?? credentialInstallationId;
    if (installationId !== undefined) {
      const operation = await writeAuthOperation(input.location, {
        configPath: input.location.configPath,
        kind: 'remove',
        fromMode: 'command',
        phase: 'retiring',
        installationId,
        providerId,
      });
      try {
        let status: AgentRevokeStatus = 'missing';
        if (identity !== undefined) {
          if (identity.status === 'active')
            await retireCodexCommandInstallation(input.location, identity.marker.installationId, lease);
          if (input.revoke !== undefined)
            status = await input.revoke(identity.marker.endpoint, identity.marker.installationId);
        }
        authorization = status;
        if (!terminalRevocations.has(status)) return blockedResult(input.location, authorization);
        await writeAuthOperation(input.location, { ...operation, phase: 'revoked' });
        await clearCodexCommandInstallation({ location: input.location, installationId, revocation: status }, lease);
      } catch {
        return blockedResult(input.location, 'pending');
      }
    }
    const result = await removeCodexConfig(input.location, lease);
    await clearAuthOperation(input.location).catch(() => undefined);
    return {
      target: 'codex',
      integration: 'static-config',
      configPath: input.location.configPath,
      keysRetained: true,
      status: result.status,
      preservedPaths: result.preservedPaths,
      ...(authorization === undefined ? {} : { authorization }),
    };
  });
}

const blockedResult = (
  location: CodexLocation,
  authorization: CodexRemoveResult['authorization'],
): CodexRemoveResult => ({
  target: 'codex',
  integration: 'static-config',
  configPath: location.configPath,
  keysRetained: true,
  status: 'blocked',
  preservedPaths: [],
  ...(authorization === undefined ? {} : { authorization }),
});
