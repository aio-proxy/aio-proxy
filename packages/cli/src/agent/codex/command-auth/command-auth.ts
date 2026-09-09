import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import {
  AgentRuntimeError,
  pollDeviceAuthorization,
  refreshAgentCredential,
  requestDeviceAuthorization,
} from '@aio-proxy/agent-provider-runtime';
import type { AgentDeviceCodeResponse, AgentManagedMarker, AgentRevokeStatus } from '@aio-proxy/types';
import { AgentManagedMarkerSchema } from '@aio-proxy/types';

import type { CodexLocation } from '../contracts';
import { withCodexInstallation, type CodexLease } from '../storage/installation-lock';
import { durableDelete, durableWrite, ensureManagedRoot, isFsCode, readRegularFile } from '../storage/storage';
import { credentialPath, readCredential, writeCredential, type CredentialState } from './credential-store';

type InstallationRecord = {
  readonly format: 1;
  readonly marker: AgentManagedMarker & { readonly agent: 'codex' };
  readonly configPath: string;
  readonly providerId: string;
  readonly status: 'pending' | 'active' | 'retiring';
};

const identityPath = (location: CodexLocation): string => `${location.managedRoot}/codex-command.json`;

function markerFor(
  location: CodexLocation,
  endpoint: string,
  installationId: string,
  adapterVersion: string,
): AgentManagedMarker & { agent: 'codex' } {
  return {
    format: 1,
    managedBy: 'aio-proxy',
    agent: 'codex',
    installationId,
    adapterVersion,
    endpoint,
  };
}

async function readIdentity(location: CodexLocation): Promise<InstallationRecord | undefined> {
  await ensureManagedRoot(location);
  const identityMetadata = await lstat(identityPath(location)).catch((error) => {
    if (isFsCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (identityMetadata?.isSymbolicLink() || (identityMetadata?.nlink ?? 1) > 1)
    throw new Error('Refusing unsafe Codex command identity');
  const file = await readRegularFile(identityPath(location));
  if (file === undefined) return undefined;
  try {
    const value = JSON.parse(file.text) as InstallationRecord;
    if (
      value.format !== 1 ||
      value.configPath !== location.configPath ||
      !AgentManagedMarkerSchema.safeParse(value.marker).success ||
      value.marker?.agent !== 'codex' ||
      value.marker?.managedBy !== 'aio-proxy' ||
      typeof value.marker.installationId !== 'string' ||
      typeof value.marker.endpoint !== 'string' ||
      !['pending', 'active', 'retiring'].includes(value.status) ||
      typeof value.providerId !== 'string'
    )
      throw new Error('invalid');
    return value;
  } catch {
    throw new Error('Invalid Codex command identity');
  }
}

async function writeIdentity(location: CodexLocation, identity: InstallationRecord): Promise<void> {
  await ensureManagedRoot(location);
  const expected = await readRegularFile(identityPath(location));
  await durableWrite(identityPath(location), `${JSON.stringify(identity)}\n`, 0o600, expected);
}

async function withLease<T>(
  location: CodexLocation,
  lease: CodexLease | undefined,
  operation: (owned: CodexLease) => Promise<T>,
): Promise<T> {
  if (lease !== undefined) return lease.withOwnership(async () => operation(lease));
  return withCodexInstallation(location, AbortSignal.timeout(15_000), operation);
}

export type CodexCommandInstallation = InstallationRecord;

export async function readCodexCommandIdentity(location: CodexLocation): Promise<CodexCommandInstallation | undefined> {
  return readIdentity(location);
}

export async function prepareCodexCommandInstallation(
  input: {
    readonly location: CodexLocation;
    readonly providerId: string;
    readonly endpoint: string;
    readonly adapterVersion: string;
  },
  lease: CodexLease,
): Promise<CodexCommandInstallation> {
  return lease.withOwnership(async () => {
    const current = await readIdentity(input.location);
    if (current !== undefined) {
      if (current.providerId !== input.providerId || current.marker.endpoint !== input.endpoint)
        throw new Error('Codex command installation is already bound to another provider');
      return current;
    }
    const installation: CodexCommandInstallation = {
      format: 1,
      marker: markerFor(input.location, input.endpoint, randomUUID(), input.adapterVersion),
      configPath: input.location.configPath,
      providerId: input.providerId,
      status: 'pending',
    };
    await writeIdentity(input.location, installation);
    return installation;
  });
}

async function authorizeOwned(
  input: {
    readonly location: CodexLocation;
    readonly installation: CodexCommandInstallation;
    readonly signal: AbortSignal;
    readonly onDevice: (device: AgentDeviceCodeResponse) => Promise<void>;
  },
  lease: CodexLease,
): Promise<void> {
  await lease.withOwnershipFence(async (assertOwned: () => Promise<void>) => {
    const current = await readIdentity(input.location);
    if (current?.marker.installationId !== input.installation.marker.installationId || current.status !== 'pending')
      throw new Error('Codex command installation is not pending');
    const device = await requestDeviceAuthorization(input.installation.marker, { signal: input.signal });
    await assertOwned();
    await input.onDevice(device);
    const tokenResponse = await pollDeviceAuthorization(input.installation.marker, device, {
      signal: input.signal,
      sleep: async () => undefined,
    });
    await assertOwned();
    const state: CredentialState = {
      format: 1,
      installationId: input.installation.marker.installationId,
      endpoint: input.installation.marker.endpoint,
      revision: 1,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token,
      accessExpiresAt: Date.now() + tokenResponse.expires_in * 1_000,
      status: 'ready',
    };
    await writeCredential(input.location, state);
  });
}

export async function authorizeCodexInstallation(
  input: {
    readonly location: CodexLocation;
    readonly installation: CodexCommandInstallation;
    readonly signal: AbortSignal;
    readonly onDevice: (device: AgentDeviceCodeResponse) => Promise<void>;
  },
  lease: CodexLease,
): Promise<void> {
  return authorizeOwned(input, lease);
}

async function updateStatus(
  location: CodexLocation,
  installationId: string,
  status: InstallationRecord['status'],
  lease: CodexLease,
): Promise<void> {
  await lease.withOwnership(async () => {
    const current = await readIdentity(location);
    if (current?.marker.installationId !== installationId) throw new Error('Codex command installation mismatch');
    await writeIdentity(location, { ...current, status });
  });
}

export async function activateCodexCommandInstallation(
  location: CodexLocation,
  installationId: string,
  lease: CodexLease,
): Promise<void> {
  const credential = await readCredential(location);
  if (credential?.installationId !== installationId || credential.status !== 'ready')
    throw new Error('Codex credential is not ready');
  await updateStatus(location, installationId, 'active', lease);
}

export async function retireCodexCommandInstallation(
  location: CodexLocation,
  installationId: string,
  lease: CodexLease,
): Promise<void> {
  await updateStatus(location, installationId, 'retiring', lease);
}

export async function clearCodexCommandInstallation(
  input: { readonly location: CodexLocation; readonly installationId: string; readonly revocation: AgentRevokeStatus },
  lease: CodexLease,
): Promise<void> {
  if (!['revoked', 'expired', 'missing'].includes(input.revocation)) throw new Error('Invalid Codex revocation status');
  await lease.withOwnership(async () => {
    const identity = await readIdentity(input.location);
    if (identity?.marker.installationId !== input.installationId)
      throw new Error('Codex command installation mismatch');
    await durableDelete(identityPath(input.location), await readRegularFile(identityPath(input.location)));
    await durableDelete(credentialPath(input.location), await readRegularFile(credentialPath(input.location)));
  });
}

function connectionFromError(error: unknown): 'offline' | 'unauthorized' | 'invalid_response' {
  if (error instanceof AgentRuntimeError) {
    if (error.code === 'network') return 'offline';
    if (error.code === 'invalid_grant' || error.code === 'invalid_client') return 'unauthorized';
    return 'invalid_response';
  }
  return 'offline';
}

export async function inspectCodexCommandCredential(input: {
  readonly location: CodexLocation;
  readonly check: boolean;
  readonly signal: AbortSignal;
}): Promise<{
  readonly credentialStatus: 'missing' | 'ready' | 'expired' | 'reauthorize';
  readonly connection: 'ok' | 'offline' | 'unauthorized' | 'invalid_response' | 'not_checked';
}> {
  const identity = await readIdentity(input.location);
  const credential = await readCredential(input.location);
  if (identity === undefined || credential === undefined)
    return { credentialStatus: 'missing', connection: 'not_checked' };
  if (credential.status === 'reauthorize') return { credentialStatus: 'reauthorize', connection: 'not_checked' };
  const expired = credential.accessExpiresAt <= Date.now();
  if (!input.check || expired) return { credentialStatus: expired ? 'expired' : 'ready', connection: 'not_checked' };
  try {
    const response = await fetch(new URL('/v1/models', identity.marker.endpoint), {
      headers: { authorization: `Bearer ${credential.accessToken}` },
      redirect: 'error',
      signal: input.signal,
    });
    if (response.status === 401) return { credentialStatus: 'ready', connection: 'unauthorized' };
    if (!response.ok) return { credentialStatus: 'ready', connection: 'invalid_response' };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { credentialStatus: 'ready', connection: 'invalid_response' };
    }
    const connection = body !== null && typeof body === 'object' ? 'ok' : 'invalid_response';
    return { credentialStatus: 'ready', connection };
  } catch (error) {
    return { credentialStatus: 'ready', connection: connectionFromError(error) };
  }
}

function boundFetch(endpoint: string, signal: AbortSignal): typeof fetch {
  const origin = new URL(endpoint).origin;
  return (async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), endpoint);
    if (url.origin !== origin) throw new AgentRuntimeError('invalid_response');
    return fetch(url, { ...init, signal, redirect: 'error' });
  }) as typeof fetch;
}

async function writeTokenOwned(
  input: {
    readonly location: CodexLocation;
    readonly installationId: string;
    readonly signal: AbortSignal;
    readonly writeToken: (token: string) => Promise<void>;
    /** Set after an upstream 401 so a still-fresh cached token is not reused. */
    readonly forceRefresh?: boolean;
  },
  lease: CodexLease,
): Promise<void> {
  await lease.withOwnershipFence(async (assertOwned: () => Promise<void>) => {
    const identity = await readIdentity(input.location);
    if (identity?.marker.installationId !== input.installationId || identity.status !== 'active')
      throw new Error('Codex command installation is not active');
    const current = await readCredential(input.location);
    if (current === undefined || current.status === 'reauthorize' || current.installationId !== input.installationId)
      throw new Error('Codex credential requires authorization');
    const now = Date.now();
    if (input.forceRefresh !== true && current.accessExpiresAt > now + 1_000 && current.deliveredBy !== undefined) {
      await input.writeToken(current.accessToken);
      await assertOwned();
      await writeCredential(input.location, { ...current, deliveredBy: lease.owner });
      return;
    }
    const requestStartedAt = Date.now();
    await writeCredential(input.location, { ...current, status: 'refreshing', refreshStartedAt: requestStartedAt });
    let committed: CredentialState | undefined;
    try {
      const response = await refreshAgentCredential(identity.marker, current.refreshToken, {
        signal: input.signal,
        fetch: boundFetch(identity.marker.endpoint, input.signal),
      });
      const next: CredentialState = {
        ...current,
        revision: current.revision + 1,
        accessToken: response.access_token,
        refreshToken: response.refresh_token,
        accessExpiresAt: requestStartedAt + response.expires_in * 1_000,
        status: 'ready',
        refreshStartedAt: undefined,
        deliveredBy: undefined,
      };
      await assertOwned();
      await writeCredential(input.location, next);
      committed = next;
      try {
        await input.writeToken(next.accessToken);
      } catch {
        throw new Error('Codex token delivery failed');
      }
      await assertOwned();
      await writeCredential(input.location, { ...next, deliveredBy: lease.owner });
    } catch (error) {
      if (committed !== undefined)
        throw error instanceof Error && error.message === 'Codex token delivery failed'
          ? error
          : new Error('Codex token delivery failed');
      if (error instanceof AgentRuntimeError && error.code === 'invalid_grant') {
        await assertOwned();
        await writeCredential(input.location, { ...current, status: 'reauthorize', refreshStartedAt: undefined });
      } else {
        await assertOwned();
        await writeCredential(input.location, { ...current, status: 'ready', refreshStartedAt: undefined });
      }
      throw error instanceof AgentRuntimeError ? new Error('Codex credential refresh failed') : error;
    }
  });
}

export async function writeCodexAuthToken(input: {
  readonly location: CodexLocation;
  readonly installationId: string;
  readonly signal: AbortSignal;
  readonly writeToken: (token: string) => Promise<void>;
  readonly forceRefresh?: boolean;
  readonly lease?: CodexLease;
}): Promise<void> {
  return withLease(input.location, input.lease, (lease) => writeTokenOwned(input, lease));
}
