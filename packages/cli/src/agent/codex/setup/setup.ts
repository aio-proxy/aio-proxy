import type { AgentRevokeStatus } from '@aio-proxy/types';

import { codexBaseUrl } from '../../control-plane';
import {
  activateCodexCommandInstallation,
  authorizeCodexInstallation,
  clearCodexCommandInstallation,
  prepareCodexCommandInstallation,
  rebindCodexCommandInstallation,
  readCodexCommandCredentialInstallationId,
  readCredential,
  inspectCodexCommandCredential,
  readCodexCommandIdentity,
  retireCodexCommandInstallation,
} from '../command-auth';
import { resolveCodexAuthCommand } from '../command-location';
import type {
  CodexAuthMode,
  CodexSetupCommit,
  CodexSetupContext,
  CodexSetupSelection,
  ConfigInspection,
} from '../contracts';
import { configureCodexConfig, inspectCodexConfig, removeCodexConfig, validateCodexConfig } from '../managed-config';
import { withCodexInstallation, type CodexLease } from '../storage/installation-lock';
import {
  authOperationPath,
  clearAuthOperation,
  readAuthOperation,
  writeAuthOperation,
  type AuthOperation,
} from './journal';

const terminalRevocations = new Set<AgentRevokeStatus>(['revoked', 'expired', 'missing']);

const setupError = (code: string): Error => new Error(code);

const modeOf = (inspection: ConfigInspection): CodexAuthMode | undefined => inspection.authMode;

async function revokeAndClear(
  context: CodexSetupContext,
  lease: CodexLease,
  expectedInstallationId?: string,
): Promise<AgentRevokeStatus> {
  const identity = await readCodexCommandIdentity(context.location);
  if (identity === undefined) {
    if (expectedInstallationId === undefined) {
      if ((await readCodexCommandCredentialInstallationId(context.location)) !== undefined)
        throw setupError('CODEX_AUTH_INSTALLATION_MISSING');
      return 'missing';
    }
    await clearCodexCommandInstallation(
      { location: context.location, installationId: expectedInstallationId, revocation: 'missing' },
      lease,
    );
    return 'missing';
  }
  if (expectedInstallationId !== undefined && identity.marker.installationId !== expectedInstallationId)
    throw setupError('CODEX_AUTH_INSTALLATION_MISMATCH');
  if (identity.status === 'active')
    await retireCodexCommandInstallation(context.location, identity.marker.installationId, lease);
  const status =
    context.revoke === undefined
      ? 'missing'
      : await context.revoke(identity.marker.endpoint, identity.marker.installationId);
  if (!terminalRevocations.has(status)) throw setupError('CODEX_AUTH_REVOKE_BLOCKED');
  await clearCodexCommandInstallation(
    { location: context.location, installationId: identity.marker.installationId, revocation: status },
    lease,
  );
  return status;
}

async function commitKeepChatgpt(
  providerId: string,
  selection: Extract<CodexSetupSelection['auth'], { mode: 'keep-chatgpt' }>,
  context: CodexSetupContext,
  inspection: ConfigInspection,
  lease: CodexLease,
): Promise<CodexSetupCommit> {
  const credential = await selection.keys.resolve(selection.selection);
  const identity = await readCodexCommandIdentity(context.location);
  const credentialInstallationId = await readCodexCommandCredentialInstallationId(context.location);
  const installationId = identity?.marker.installationId ?? credentialInstallationId;
  await validateCodexConfig(
    {
      location: context.location,
      providerId,
      baseUrl: codexBaseUrl(context.endpoint),
      auth: { mode: 'keep-chatgpt', token: credential.token },
    },
    lease,
  );
  const fromMode = modeOf(inspection);
  if (installationId !== undefined) {
    const operation = await writeAuthOperation(context.location, {
      configPath: context.location.configPath,
      kind: 'switch',
      ...(fromMode === undefined ? {} : { fromMode }),
      targetMode: 'keep-chatgpt',
      phase: 'retiring',
      installationId,
      providerId,
    });
    await revokeAndClear(context, lease, installationId);
    await writeAuthOperation(context.location, { ...operation, phase: 'revoked' });
  }
  const commit = await configureCodexConfig(
    {
      location: context.location,
      providerId,
      baseUrl: codexBaseUrl(context.endpoint),
      auth: { mode: 'keep-chatgpt', token: credential.token },
    },
    lease,
  );
  await clearAuthOperation(context.location);
  return {
    ...commit,
    authMode: 'keep-chatgpt',
    credential: credential.kind,
    connection: credential.kind === 'placeholder' ? 'not_checked' : credential.verified ? 'ok' : 'offline',
  };
}

async function commitCommand(
  providerId: string,
  selection: Extract<CodexSetupSelection['auth'], { mode: 'command' }>,
  context: CodexSetupContext,
  inspection: ConfigInspection,
  lease: CodexLease,
): Promise<CodexSetupCommit> {
  const existing = await readCodexCommandIdentity(context.location);
  if (existing !== undefined && existing.marker.endpoint !== context.endpoint)
    throw setupError('CODEX_AUTH_ENDPOINT_OR_PROVIDER_CHANGED');
  const prepared =
    existing ??
    (await prepareCodexCommandInstallation(
      {
        location: context.location,
        providerId,
        endpoint: context.endpoint,
        adapterVersion: context.adapterVersion,
      },
      lease,
    ));
  const operation = await writeAuthOperation(context.location, {
    configPath: context.location.configPath,
    kind: inspection.authMode === undefined ? 'configure' : 'switch',
    ...(inspection.authMode === undefined ? {} : { fromMode: inspection.authMode }),
    targetMode: 'command',
    phase: 'prepared',
    installationId: prepared.marker.installationId,
    providerId,
  });
  const credential = await readCredential(context.location);
  let needsAuthorization =
    prepared.status === 'pending' ||
    credential === undefined ||
    credential.status === 'reauthorize' ||
    credential.accessExpiresAt <= Date.now();
  if (!needsAuthorization && prepared.status === 'active') {
    const checked = await inspectCodexCommandCredential({
      location: context.location,
      check: true,
      signal: context.signal,
    });
    needsAuthorization =
      checked.credentialStatus === 'expired' ||
      checked.credentialStatus === 'reauthorize' ||
      checked.connection === 'unauthorized';
  }
  if (needsAuthorization) {
    await authorizeCodexInstallation(
      {
        location: context.location,
        installation: prepared,
        signal: context.signal,
        onDevice: context.onDevice,
      },
      lease,
    );
    await writeAuthOperation(context.location, { ...operation, phase: 'authorized' });
  }
  const commit = await configureCodexConfig(
    {
      location: context.location,
      providerId,
      baseUrl: codexBaseUrl(context.endpoint),
      auth: {
        mode: 'command',
        installationId: prepared.marker.installationId,
        command: selection.command,
      },
    },
    lease,
  );
  await writeAuthOperation(context.location, { ...operation, phase: 'config-written' });
  if (prepared.providerId !== providerId)
    await rebindCodexCommandInstallation(context.location, prepared.marker.installationId, providerId, lease);
  await activateCodexCommandInstallation(context.location, prepared.marker.installationId, lease);
  await clearAuthOperation(context.location);
  return {
    ...commit,
    authMode: 'command',
    credential: 'agent',
    connection: 'ok',
    installationId: prepared.marker.installationId,
  };
}

export async function commitCodexSetup(
  selection: CodexSetupSelection,
  context: CodexSetupContext,
): Promise<CodexSetupCommit> {
  return withCodexInstallation(context.location, context.signal, async (lease) => {
    const pending = await readAuthOperation(context.location);
    if (pending !== undefined) throw setupError('CODEX_AUTH_OPERATION_PENDING');
    const inspection = await inspectCodexConfig(context.location);
    if (selection.auth.mode === 'keep-chatgpt')
      return commitKeepChatgpt(selection.providerId, selection.auth, context, inspection, lease);
    return commitCommand(selection.providerId, selection.auth, context, inspection, lease);
  });
}

async function recoverComplete(
  context: CodexSetupContext,
  operation: AuthOperation,
  lease: CodexLease,
): Promise<boolean> {
  if (operation.targetMode !== 'command' || operation.installationId === undefined) return false;
  const identity = await readCodexCommandIdentity(context.location);
  if (identity?.marker.installationId !== operation.installationId || identity.marker.endpoint !== context.endpoint)
    return false;
  if (identity.status === 'pending') {
    await authorizeCodexInstallation(
      { location: context.location, installation: identity, signal: context.signal, onDevice: context.onDevice },
      lease,
    );
  }
  await configureCodexConfig(
    {
      location: context.location,
      providerId: operation.providerId,
      baseUrl: codexBaseUrl(context.endpoint),
      auth: {
        mode: 'command',
        installationId: operation.installationId,
        command: await resolveCodexAuthCommand(),
      },
    },
    lease,
  );
  if (identity.providerId !== operation.providerId)
    await rebindCodexCommandInstallation(context.location, operation.installationId, operation.providerId, lease);
  await activateCodexCommandInstallation(context.location, operation.installationId, lease);
  await clearAuthOperation(context.location);
  return true;
}

async function recoverKeepChatgpt(
  context: CodexSetupContext,
  operation: AuthOperation,
  lease: CodexLease,
): Promise<boolean> {
  await revokeAndClear(context, lease, operation.installationId);
  const inspection = await inspectCodexConfig(context.location);
  if (inspection.authMode === 'keep-chatgpt' || inspection.providerId === undefined) {
    await clearAuthOperation(context.location);
    return true;
  }
  await removeCodexConfig(context.location, lease);
  await clearAuthOperation(context.location);
  return true;
}

export async function recoverCodexAuthOperation(
  context: CodexSetupContext,
  action: 'complete' | 'remove',
): Promise<'none' | 'completed' | 'blocked'> {
  return withCodexInstallation(context.location, context.signal, async (lease) => {
    let operation: AuthOperation | undefined;
    try {
      operation = await readAuthOperation(context.location);
    } catch {
      return 'blocked';
    }
    if (operation === undefined) return 'none';
    if (action === 'complete') {
      try {
        if (operation.targetMode === 'keep-chatgpt')
          return (await recoverKeepChatgpt(context, operation, lease)) ? 'completed' : 'blocked';
        return (await recoverComplete(context, operation, lease)) ? 'completed' : 'blocked';
      } catch {
        return 'blocked';
      }
    }
    try {
      await revokeAndClear(context, lease, operation?.installationId);
      await removeCodexConfig(context.location, lease);
      await clearAuthOperation(context.location);
      return 'completed';
    } catch {
      return 'blocked';
    }
  });
}

export { authOperationPath };
