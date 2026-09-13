import { AgentRuntimeError, refreshAgentCredential } from '@aio-proxy/agent-provider-runtime';

import type { CodexLocation } from '../contracts';
import { withCodexInstallation, type CodexLease } from '../storage/installation-lock';
import { assertManagedInstallation, boundFetch, isRecentRefresh, readIdentity } from './command-auth';
import { readCredential, writeCredential, type CredentialState } from './credential-store';

async function withLease<T>(
  location: CodexLocation,
  signal: AbortSignal,
  lease: CodexLease | undefined,
  operation: (owned: CodexLease) => Promise<T>,
): Promise<T> {
  if (lease !== undefined) return lease.withOwnership(async () => operation(lease));
  return withCodexInstallation(location, signal, operation);
}

async function writeTokenOwned(
  input: {
    readonly location: CodexLocation;
    readonly installationId: string;
    readonly signal: AbortSignal;
    readonly writeToken: (token: string) => Promise<void>;
    readonly forceRefresh?: boolean;
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
    if (input.forceRefresh !== true && current.status === 'ready' && current.accessExpiresAt > now + 1_000) {
      const probe = await probeAccessToken({
        endpoint: identity.marker.endpoint,
        accessToken: current.accessToken,
        signal: input.signal,
      });
      if (probe !== 'unauthorized') {
        await input.writeToken(current.accessToken);
        await assertOwned();
        await writeCredential(input.location, {
          ...current,
          deliveredRevision: current.revision,
          deliveredBy: current.deliveredBy ?? lease.owner,
          deliveredAt: now,
        });
        return;
      }
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

async function probeAccessToken(input: {
  readonly endpoint: string;
  readonly accessToken: string;
  readonly signal: AbortSignal;
}): Promise<'ok' | 'unauthorized' | 'invalid'> {
  try {
    const response = await fetch(new URL('/v1/models', input.endpoint), {
      headers: { authorization: `Bearer ${input.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(1_000)]),
    });
    if (response.status === 401) return 'unauthorized';
    return 'ok';
  } catch {
    return 'invalid';
  }
}

export async function writeCodexAuthToken(input: {
  readonly location: CodexLocation;
  readonly installationId: string;
  readonly signal: AbortSignal;
  readonly writeToken: (token: string) => Promise<void>;
  readonly forceRefresh?: boolean;
  readonly lease?: CodexLease;
}): Promise<void> {
  return withLease(input.location, input.signal, input.lease, (lease) => writeTokenOwned(input, lease));
}
