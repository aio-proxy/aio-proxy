import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';

import {
  AgentRuntimeError,
  pollDeviceAuthorization,
  refreshAgentCredential,
  requestDeviceAuthorization,
} from '@aio-proxy/agent-provider-runtime';
import { observeProcessFileLock } from '@aio-proxy/core';
import type { AgentDeviceCodeResponse, AgentManagedMarker, AgentRevokeStatus } from '@aio-proxy/types';
import { AgentManagedMarkerSchema } from '@aio-proxy/types';

import type { CodexLocation } from '../contracts';
import { inspectCodexConfig } from '../managed-config';
import { withCodexInstallation, type CodexLease } from '../storage/installation-lock';
import { durableDelete, durableWrite, ensureManagedRoot, isFsCode, readRegularFile } from '../storage/storage';
import { connectionFromError } from './connection-status';
import { credentialPath, readCredential, writeCredential, type CredentialState } from './credential-store';

const REFRESH_REPLAY_WINDOW_MS = 30_000;

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
  if (
    identityMetadata?.isSymbolicLink() ||
    (identityMetadata?.nlink ?? 1) > 1 ||
    (identityMetadata !== undefined && (identityMetadata.mode & 0o077) !== 0)
  )
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
  if (expected !== undefined && (expected.stat.isSymbolicLink() || expected.stat.nlink > 1))
    throw new Error('Refusing unsafe Codex command identity');
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

export async function readCodexCommandCredentialInstallationId(location: CodexLocation): Promise<string | undefined> {
  return (await readCredential(location))?.installationId;
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
      if (current.marker.endpoint !== input.endpoint)
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

export async function rebindCodexCommandInstallation(
  location: CodexLocation,
  installationId: string,
  providerId: string,
  lease: CodexLease,
): Promise<void> {
  await lease.withOwnership(async () => {
    const current = await readIdentity(location);
    if (current?.marker.installationId !== installationId) throw new Error('Codex command installation mismatch');
    await writeIdentity(location, { ...current, providerId });
  });
}

async function authorizeOwned(
  input: {
    readonly location: CodexLocation;
    readonly installation: CodexCommandInstallation;
    readonly signal: AbortSignal;
    readonly onDevice: (device: AgentDeviceCodeResponse) => Promise<void>;
    readonly pollDeviceAuthorization?: typeof pollDeviceAuthorization;
  },
  lease: CodexLease,
): Promise<void> {
  await lease.withOwnershipFence(async (assertOwned: () => Promise<void>) => {
    const current = await readIdentity(input.location);
    if (current?.marker.installationId !== input.installation.marker.installationId || current.status !== 'pending')
      throw new Error('Codex command installation is not pending');
    await assertManagedInstallation(input.location, current);
    const cached = await readCredential(input.location);
    if (
      cached !== undefined &&
      (cached.installationId !== current.marker.installationId || cached.endpoint !== current.marker.endpoint)
    )
      throw new Error('Codex credential endpoint or installation does not match');
    if (
      cached !== undefined &&
      cached.installationId === current.marker.installationId &&
      cached.endpoint === current.marker.endpoint
    ) {
      if (cached.status === 'ready' && cached.accessExpiresAt > Date.now() + 1_000) return;
      if (cached.status === 'refreshing' && !isRecentRefresh(cached.refreshStartedAt, Date.now())) {
        await writeCredential(input.location, { ...cached, status: 'reauthorize', refreshStartedAt: undefined });
      } else if (cached.status === 'ready' || isRecentRefresh(cached.refreshStartedAt, Date.now())) {
        const requestStartedAt = cached.refreshStartedAt ?? Date.now();
        const refreshing = { ...cached, status: 'refreshing' as const, refreshStartedAt: requestStartedAt };
        await writeCredential(input.location, refreshing);
        try {
          const response = await refreshAgentCredential(current.marker, cached.refreshToken, {
            signal: input.signal,
            fetch: boundFetch(current.marker.endpoint, input.signal),
          });
          await assertOwned();
          await writeCredential(input.location, {
            ...cached,
            revision: cached.revision + 1,
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            accessExpiresAt: requestStartedAt + response.expires_in * 1_000,
            status: 'ready',
            refreshStartedAt: undefined,
            deliveredBy: undefined,
            deliveredRevision: undefined,
            deliveredAt: undefined,
          });
          return;
        } catch (error) {
          await assertOwned();
          if (error instanceof AgentRuntimeError && error.code === 'invalid_grant') {
            await writeCredential(input.location, { ...cached, status: 'reauthorize', refreshStartedAt: undefined });
          } else {
            await writeCredential(input.location, { ...cached, status: 'ready', refreshStartedAt: undefined });
            throw error;
          }
        }
      }
    }
    const device = await requestDeviceAuthorization(input.installation.marker, { signal: input.signal });
    await assertOwned();
    await input.onDevice(device);
    const tokenResponse = await (input.pollDeviceAuthorization ?? pollDeviceAuthorization)(
      input.installation.marker,
      device,
      { signal: input.signal },
    );
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
      deliveredRevision: undefined,
      deliveredAt: undefined,
    };
    await writeCredential(input.location, state);
  });
}

async function assertManagedInstallation(
  location: CodexLocation,
  identity: InstallationRecord,
  requireManaged = false,
): Promise<void> {
  assertManagedInspection(identity, await inspectCodexConfig(location), requireManaged);
}

function assertManagedInspection(
  identity: InstallationRecord,
  inspection: Awaited<ReturnType<typeof inspectCodexConfig>>,
  requireManaged = false,
): void {
  if (inspection.status === 'conflict') throw new Error('Codex managed configuration is invalid');
  if (inspection.providerId === undefined) {
    if (requireManaged) throw new Error('Codex managed configuration is missing');
    return;
  }
  if (
    inspection.status !== 'managed' ||
    inspection.providerId !== identity.providerId ||
    inspection.authMode !== 'command' ||
    inspection.installationId !== identity.marker.installationId
  )
    throw new Error('Codex managed configuration does not match the command installation');
  if (inspection.baseUrl !== undefined) {
    const configured = new URL(inspection.baseUrl);
    const endpoint = new URL(identity.marker.endpoint);
    if (
      configured.origin !== endpoint.origin ||
      configured.pathname.replace(/\/+$/u, '') !== `${endpoint.pathname.replace(/\/+$/u, '')}/v1`
    )
      throw new Error('Codex managed endpoint does not match the command installation');
  }
}

const isRecentRefresh = (start: number | undefined, now: number) =>
  start !== undefined && start <= now && now - start <= REFRESH_REPLAY_WINDOW_MS;

export async function authorizeCodexInstallation(
  input: {
    readonly location: CodexLocation;
    readonly installation: CodexCommandInstallation;
    readonly signal: AbortSignal;
    readonly onDevice: (device: AgentDeviceCodeResponse) => Promise<void>;
    readonly pollDeviceAuthorization?: typeof pollDeviceAuthorization;
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
  await lease.withOwnershipFence(async (assertOwned) => {
    const identity = await readIdentity(location);
    if (identity?.marker.installationId !== installationId) throw new Error('Codex command installation mismatch');
    await assertManagedInstallation(location, identity, true);
    const credential = await readCredential(location);
    if (credential?.installationId !== installationId || credential.status !== 'ready')
      throw new Error('Codex credential is not ready');
    await assertOwned();
    await writeIdentity(location, { ...identity, status: 'active' });
  });
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
    if (identity !== undefined && identity.marker.installationId !== input.installationId)
      throw new Error('Codex command installation mismatch');
    const identityFile = await readRegularFile(identityPath(input.location));
    if (identityFile !== undefined && (identityFile.stat.nlink > 1 || (Number(identityFile.stat.mode) & 0o077) !== 0))
      throw new Error('Refusing unsafe Codex command identity');
    const credentialFile = await readRegularFile(credentialPath(input.location));
    if (
      credentialFile !== undefined &&
      (credentialFile.stat.nlink > 1 || (Number(credentialFile.stat.mode) & 0o077) !== 0)
    )
      throw new Error('Refusing unsafe Codex credential file');
    const credential = await readCredential(input.location);
    if (credential !== undefined && credential.installationId !== input.installationId)
      throw new Error('Codex command installation mismatch');
    await durableDelete(credentialPath(input.location), credentialFile);
    await durableDelete(identityPath(input.location), identityFile);
  });
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
  try {
    assertManagedInspection(identity, await inspectCodexConfig(input.location), true);
  } catch {
    return { credentialStatus: 'reauthorize', connection: 'not_checked' };
  }
  if (
    credential.status === 'reauthorize' ||
    credential.installationId !== identity.marker.installationId ||
    credential.endpoint !== identity.marker.endpoint
  )
    return { credentialStatus: 'reauthorize', connection: 'not_checked' };
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
    /** Owner observed before acquiring the installation lock, if any. */
    readonly observedOwner?: string;
  },
  lease: CodexLease,
): Promise<void> {
  await lease.withOwnershipFence(async (assertOwned: () => Promise<void>) => {
    const identity = await readIdentity(input.location);
    if (identity?.marker.installationId !== input.installationId || identity.status !== 'active')
      throw new Error('Codex command installation is not active');
    await assertManagedInstallation(input.location, identity, true);
    const current = await readCredential(input.location);
    if (
      current === undefined ||
      current.status === 'reauthorize' ||
      current.installationId !== input.installationId ||
      current.endpoint !== identity.marker.endpoint
    )
      throw new Error('Codex credential requires authorization');
    const now = Date.now();
    if (current.status === 'refreshing' && !isRecentRefresh(current.refreshStartedAt, now)) {
      await assertOwned();
      await writeCredential(input.location, { ...current, status: 'reauthorize', refreshStartedAt: undefined });
      throw new Error('Codex credential refresh replay_lost; reauthorize required');
    }
    if (
      input.forceRefresh !== true &&
      current.status === 'ready' &&
      current.accessExpiresAt > now + 1_000 &&
      current.deliveredBy !== undefined &&
      current.deliveredRevision === current.revision &&
      input.observedOwner !== undefined &&
      current.deliveredBy === input.observedOwner
    ) {
      await input.writeToken(current.accessToken);
      await assertOwned();
      await writeCredential(input.location, {
        ...current,
        deliveredBy: lease.owner,
        deliveredRevision: current.revision,
        deliveredAt: now,
      });
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
      await writeCredential(input.location, {
        ...next,
        deliveredBy: lease.owner,
        deliveredRevision: next.revision,
        deliveredAt: Date.now(),
      });
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
  const observedOwner =
    input.lease === undefined
      ? (await observeProcessFileLock(`${input.location.home}/.aio-proxy.lock`))?.owner
      : undefined;
  return withLease(input.location, input.lease, (lease) =>
    writeTokenOwned({ ...input, ...(observedOwner === undefined ? {} : { observedOwner }) }, lease),
  );
}
