import type { Database } from 'bun:sqlite';

import {
  AGENT_CLIENT_ID,
  type AgentInstallationSummary,
  type AgentRevokeStatus,
  type AgentTarget,
} from '@aio-proxy/types';

import { createAgentIdentityRepository } from './repository';
import { createAgentToken, hashAgentToken } from './tokens';

export type AgentCredentialIssueInput = {
  readonly installationId: string;
  readonly target: AgentTarget;
  readonly adapterVersion: string;
};
export type AgentRefreshInput = {
  readonly clientId: (typeof AGENT_CLIENT_ID)[AgentTarget];
  readonly refreshToken: string;
};
export type AgentAccessGrant = {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly installationId: string;
  readonly target: AgentTarget;
  readonly expiresAt: number;
};
export type AgentAccessAuthentication =
  | { readonly status: 'valid'; readonly grant: AgentAccessGrant }
  | { readonly status: 'invalid' | 'expired' };
export type IssuedAgentCredential = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: 900;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
};
export type AgentRefreshResult =
  | ({ readonly status: 'success' } & IssuedAgentCredential)
  | {
      readonly status: 'invalid_grant';
      readonly reason: 'invalid' | 'client_mismatch' | 'replay_lost' | 'reuse';
      readonly familyRevoked: boolean;
    };
export type AgentRefreshSuccess = Extract<AgentRefreshResult, { readonly status: 'success' }>;
export class AgentInstallationTargetMismatchError extends Error {
  constructor() {
    super('Agent installation is already bound to another target');
    this.name = 'AgentInstallationTargetMismatchError';
  }
}
export type AgentIdentityService = {
  readonly authenticateAccessToken: (token: string) => AgentAccessAuthentication;
  readonly issueCredential: (input: AgentCredentialIssueInput) => IssuedAgentCredential;
  readonly refreshCredential: (input: AgentRefreshInput) => AgentRefreshResult;
  readonly listInstallations: () => readonly AgentInstallationSummary[];
  readonly revokeInstallation: (installationId: string) => AgentRevokeStatus;
};
type AgentIdentityOptions = {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
  readonly randomUUID?: () => string;
};
type StoredRefresh = NonNullable<ReturnType<ReturnType<typeof createAgentIdentityRepository>['readRefresh']>>;

const ACCESS_TTL_MS = 15 * 60_000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60_000;
const REPLAY_MS = 30_000;
const MAX_REPLAY_RESULTS = 1_024;
const RETENTION_MS = 90 * 24 * 60 * 60_000;

export function createAgentIdentityService(sqlite: Database, options: AgentIdentityOptions = {}): AgentIdentityService {
  const now = options.now ?? Date.now;
  const repo = createAgentIdentityRepository(sqlite);
  const access = new Map(repo.loadActiveAccess(now()).map((grant) => [grant.tokenHash, grant]));
  const replay = new Map<string, { readonly until: number; readonly result: AgentRefreshSuccess }>();
  const makeUuid = options.randomUUID ?? crypto.randomUUID;
  const makeBytes = options.randomBytes;

  function authenticateAccessToken(token: string): AgentAccessAuthentication {
    const hash = hashAgentToken(token);
    const grant = access.get(hash);
    if (grant === undefined) return { status: 'invalid' };
    if (grant.expiresAt <= now()) {
      access.delete(hash);
      return { status: 'expired' };
    }
    return { status: 'valid', grant };
  }

  function refreshCredential(input: AgentRefreshInput): AgentRefreshResult {
    const timestamp = now();
    const oldHash = hashAgentToken(input.refreshToken);
    const row = repo.readRefresh(oldHash);
    if (row === null || row.revokedAt !== null)
      return { status: 'invalid_grant', reason: 'invalid', familyRevoked: row !== null && row.revokedAt !== null };
    if (AGENT_CLIENT_ID[row.target] !== input.clientId)
      return { status: 'invalid_grant', reason: 'client_mismatch', familyRevoked: false };
    const cached = replay.get(oldHash);
    if (cached !== undefined && cached.until > timestamp) return cached.result;
    if (row.expiresAt <= timestamp) return { status: 'invalid_grant', reason: 'invalid', familyRevoked: false };
    if (row.consumedAt !== null) {
      if (timestamp - row.consumedAt <= REPLAY_MS)
        return { status: 'invalid_grant', reason: 'replay_lost', familyRevoked: false };
      repo.revokeFamily(row.familyId, timestamp);
      removeFamilyAccess(row.familyId);
      return { status: 'invalid_grant', reason: 'reuse', familyRevoked: true };
    }
    const result = rotate(row, timestamp);
    if (replay.size >= MAX_REPLAY_RESULTS) {
      const oldest = replay.keys().next().value;
      if (oldest !== undefined) replay.delete(oldest);
    }
    replay.set(oldHash, { until: timestamp + REPLAY_MS, result });
    return result;
  }

  function createCredentialPair(timestamp: number): IssuedAgentCredential {
    return {
      accessToken: createAgentToken('access', makeBytes),
      refreshToken: createAgentToken('refresh', makeBytes),
      expiresIn: 900,
      accessExpiresAt: timestamp + ACCESS_TTL_MS,
      refreshExpiresAt: timestamp + REFRESH_TTL_MS,
    };
  }

  function removeFamilyAccess(familyId: string): void {
    for (const [hash, grant] of access) if (grant.familyId === familyId) access.delete(hash);
  }

  function cleanup(timestamp: number): void {
    for (const [hash, grant] of access) if (grant.expiresAt <= timestamp) access.delete(hash);
    for (const [hash, entry] of replay) if (entry.until <= timestamp) replay.delete(hash);
    repo.cleanup(timestamp, RETENTION_MS);
  }

  function issueCredential(input: AgentCredentialIssueInput): IssuedAgentCredential {
    const timestamp = now();
    const familyId = makeUuid();
    const result = createCredentialPair(timestamp);
    const issued = repo.issue({
      ...input,
      familyId,
      accessHash: hashAgentToken(result.accessToken),
      refreshHash: hashAgentToken(result.refreshToken),
      now: timestamp,
      accessExpiresAt: result.accessExpiresAt,
      refreshExpiresAt: result.refreshExpiresAt,
    });
    if (issued.status === 'target_mismatch') throw new AgentInstallationTargetMismatchError();
    for (const replaced of issued.replacedFamilyIds) removeFamilyAccess(replaced);
    access.set(hashAgentToken(result.accessToken), {
      tokenHash: hashAgentToken(result.accessToken),
      familyId,
      installationId: input.installationId,
      target: input.target,
      expiresAt: result.accessExpiresAt,
    });
    cleanup(timestamp);
    return result;
  }

  function rotate(row: StoredRefresh, timestamp: number): AgentRefreshSuccess {
    const result = createCredentialPair(timestamp);
    const nextAccessHash = hashAgentToken(result.accessToken);
    const changed = repo.rotate({
      familyId: row.familyId,
      currentRefreshHash: row.tokenHash,
      nextAccessHash,
      nextRefreshHash: hashAgentToken(result.refreshToken),
      now: timestamp,
      accessExpiresAt: result.accessExpiresAt,
      refreshExpiresAt: result.refreshExpiresAt,
    });
    if (!changed) throw new Error('agent refresh rotation lost its immediate transaction');
    removeFamilyAccess(row.familyId);
    access.set(nextAccessHash, {
      tokenHash: nextAccessHash,
      familyId: row.familyId,
      installationId: row.installationId,
      target: row.target,
      expiresAt: result.accessExpiresAt,
    });
    cleanup(timestamp);
    return { status: 'success', ...result };
  }

  function revokeInstallation(installationId: string): AgentRevokeStatus {
    const result = repo.revokeInstallation(installationId, now());
    if (result.familyId !== undefined) removeFamilyAccess(result.familyId);
    cleanup(now());
    return result.status;
  }

  function listInstallations(): readonly AgentInstallationSummary[] {
    return repo.listInstallations(now());
  }

  cleanup(now());
  return { authenticateAccessToken, issueCredential, refreshCredential, listInstallations, revokeInstallation };
}
