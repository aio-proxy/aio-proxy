import type { Database } from 'bun:sqlite';

import type { AgentInstallationSummary, AgentRevokeStatus, AgentTarget } from '@aio-proxy/types';

type IssueRowsInput = {
  readonly installationId: string;
  readonly target: AgentTarget;
  readonly adapterVersion: string;
  readonly familyId: string;
  readonly accessHash: string;
  readonly refreshHash: string;
  readonly now: number;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
};
type RotateRowsInput = {
  readonly familyId: string;
  readonly currentRefreshHash: string;
  readonly nextAccessHash: string;
  readonly nextRefreshHash: string;
  readonly now: number;
  readonly accessExpiresAt: number;
  readonly refreshExpiresAt: number;
};
type StoredFamily = {
  readonly familyId: string;
  readonly installationId: string;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  readonly refreshExpiresAt: number;
};
type StoredRefresh = {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly installationId: string;
  readonly target: AgentTarget;
  readonly consumedAt: number | null;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
};
type StoredAccessGrant = {
  readonly tokenHash: string;
  readonly familyId: string;
  readonly installationId: string;
  readonly target: AgentTarget;
  readonly expiresAt: number;
};
type IssueRowsResult =
  | { readonly status: 'issued'; readonly replacedFamilyIds: readonly string[] }
  | { readonly status: 'target_mismatch' };

type AgentIdentityRepository = {
  readonly issue: (input: IssueRowsInput) => IssueRowsResult;
  readonly rotate: (input: RotateRowsInput) => boolean;
  readonly readFamily: (familyId: string) => StoredFamily | null;
  readonly readRefresh: (tokenHash: string) => StoredRefresh | null;
  readonly loadActiveAccess: (now: number) => readonly StoredAccessGrant[];
  readonly revokeFamily: (familyId: string, now: number) => boolean;
  readonly revokeInstallation: (
    installationId: string,
    now: number,
  ) => {
    readonly status: AgentRevokeStatus;
    readonly familyId?: string;
  };
  readonly listInstallations: (now: number) => readonly AgentInstallationSummary[];
  readonly cleanup: (now: number, retentionMs: number) => void;
};

type TargetRow = { readonly target: string };
type FamilyIdRow = { readonly family_id: string };
type FamilyRow = {
  readonly family_id: string;
  readonly installation_id: string;
  readonly created_at: number;
  readonly revoked_at: number | null;
  readonly refresh_expires_at: number;
};
type RefreshRow = {
  readonly token_hash: string;
  readonly family_id: string;
  readonly installation_id: string;
  readonly target: string;
  readonly consumed_at: number | null;
  readonly expires_at: number;
  readonly revoked_at: number | null;
};
type AccessGrantRow = {
  readonly token_hash: string;
  readonly family_id: string;
  readonly installation_id: string;
  readonly target: string;
  readonly expires_at: number;
};
type CurrentFamilyRow = {
  readonly family_id: string;
  readonly refresh_expires_at: number;
};
type InstallationListRow = {
  readonly installation_id: string;
  readonly target: string;
  readonly adapter_version: string;
  readonly created_at: number;
  readonly last_authorized_at: number;
  readonly refresh_expires_at: number | null;
  readonly access_expires_at: number | null;
};

const toIso = (value: number): string => new Date(value).toISOString();

const asAgentTarget = (value: string): AgentTarget => {
  if (value === 'opencode' || value === 'pi' || value === 'omp') return value;
  throw new Error(`invalid agent target: ${value}`);
};

function prepareStatements(sqlite: Database) {
  return {
    selectInstallationTarget: sqlite.query<TargetRow, [string]>(
      'SELECT target FROM agent_installation WHERE installation_id = ?',
    ),
    upsertInstallation: sqlite.query(
      `INSERT INTO agent_installation
        (installation_id, target, created_at, last_authorized_at, adapter_version)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (installation_id) DO UPDATE SET
         last_authorized_at = excluded.last_authorized_at,
         adapter_version = excluded.adapter_version`,
    ),
    selectCurrentFamilyIds: sqlite.query<FamilyIdRow, [string]>(
      'SELECT family_id FROM agent_token_family WHERE installation_id = ? AND revoked_at IS NULL',
    ),
    revokeCurrentFamilies: sqlite.query(
      'UPDATE agent_token_family SET revoked_at = ? WHERE installation_id = ? AND revoked_at IS NULL',
    ),
    insertFamily: sqlite.query(
      `INSERT INTO agent_token_family
        (family_id, installation_id, created_at, revoked_at, refresh_expires_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ),
    insertAccess: sqlite.query('INSERT INTO agent_access_token (token_hash, family_id, expires_at) VALUES (?, ?, ?)'),
    insertRefresh: sqlite.query(
      `INSERT INTO agent_refresh_token
        (token_hash, family_id, issued_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, NULL)`,
    ),
    consumeRefresh: sqlite.query(
      'UPDATE agent_refresh_token SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL',
    ),
    deleteFamilyAccess: sqlite.query('DELETE FROM agent_access_token WHERE family_id = ?'),
    updateFamilyRefreshExpiry: sqlite.query('UPDATE agent_token_family SET refresh_expires_at = ? WHERE family_id = ?'),
    selectFamily: sqlite.query<FamilyRow, [string]>(
      `SELECT family_id, installation_id, created_at, revoked_at, refresh_expires_at
       FROM agent_token_family WHERE family_id = ?`,
    ),
    selectRefresh: sqlite.query<RefreshRow, [string]>(
      `SELECT r.token_hash, r.family_id, i.installation_id, i.target, r.consumed_at, r.expires_at,
              f.revoked_at
       FROM agent_refresh_token r
       JOIN agent_token_family f ON f.family_id = r.family_id
       JOIN agent_installation i ON i.installation_id = f.installation_id
       WHERE r.token_hash = ?`,
    ),
    selectActiveAccess: sqlite.query<AccessGrantRow, [number]>(
      `SELECT a.token_hash, a.family_id, i.installation_id, i.target, a.expires_at
       FROM agent_access_token a
       JOIN agent_token_family f ON f.family_id = a.family_id
       JOIN agent_installation i ON i.installation_id = f.installation_id
       WHERE f.revoked_at IS NULL AND a.expires_at > ?`,
    ),
    revokeFamilyById: sqlite.query(
      'UPDATE agent_token_family SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL',
    ),
    selectCurrentFamily: sqlite.query<CurrentFamilyRow, [string]>(
      `SELECT family_id, refresh_expires_at
       FROM agent_token_family WHERE installation_id = ? AND revoked_at IS NULL`,
    ),
    selectInstallations: sqlite.query<InstallationListRow, []>(
      `SELECT i.installation_id, i.target, i.adapter_version, i.created_at, i.last_authorized_at,
              f.refresh_expires_at, MAX(a.expires_at) AS access_expires_at
       FROM agent_installation i
       LEFT JOIN agent_token_family f
         ON f.installation_id = i.installation_id AND f.revoked_at IS NULL
       LEFT JOIN agent_access_token a ON a.family_id = f.family_id
       GROUP BY i.installation_id
       ORDER BY i.last_authorized_at DESC, i.installation_id`,
    ),
    deleteExpiredAccess: sqlite.query('DELETE FROM agent_access_token WHERE expires_at <= ?'),
    deleteExpiredRefresh: sqlite.query('DELETE FROM agent_refresh_token WHERE expires_at <= ?'),
    deleteTerminalFamilies: sqlite.query(
      'DELETE FROM agent_token_family WHERE MAX(revoked_at, refresh_expires_at) + ? <= ?',
    ),
    deleteOrphanInstallations: sqlite.query(
      `DELETE FROM agent_installation
       WHERE NOT EXISTS (
         SELECT 1 FROM agent_token_family f WHERE f.installation_id = agent_installation.installation_id
       )`,
    ),
  };
}

function storedFamily(row: FamilyRow): StoredFamily {
  return {
    familyId: row.family_id,
    installationId: row.installation_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    refreshExpiresAt: row.refresh_expires_at,
  };
}

function storedRefresh(row: RefreshRow): StoredRefresh {
  return {
    tokenHash: row.token_hash,
    familyId: row.family_id,
    installationId: row.installation_id,
    target: asAgentTarget(row.target),
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function storedAccessGrant(row: AccessGrantRow): StoredAccessGrant {
  return {
    tokenHash: row.token_hash,
    familyId: row.family_id,
    installationId: row.installation_id,
    target: asAgentTarget(row.target),
    expiresAt: row.expires_at,
  };
}

function installationSummary(row: InstallationListRow, now: number): AgentInstallationSummary {
  return {
    installationId: row.installation_id,
    target: asAgentTarget(row.target),
    adapterVersion: row.adapter_version,
    createdAt: toIso(row.created_at),
    lastAuthorizedAt: toIso(row.last_authorized_at),
    authorization: row.refresh_expires_at === null ? 'revoked' : row.refresh_expires_at <= now ? 'expired' : 'active',
    accessExpiresAt: row.access_expires_at === null ? null : toIso(row.access_expires_at),
  };
}

export function createAgentIdentityRepository(sqlite: Database): AgentIdentityRepository {
  const stmts = prepareStatements(sqlite);
  const issueRows = sqlite.transaction((input: IssueRowsInput): IssueRowsResult => {
    const existing = stmts.selectInstallationTarget.get(input.installationId);
    if (existing !== null && existing.target !== input.target) return { status: 'target_mismatch' };
    stmts.upsertInstallation.run(input.installationId, input.target, input.now, input.now, input.adapterVersion);
    const replacedFamilyIds = stmts.selectCurrentFamilyIds.all(input.installationId).map(({ family_id }) => family_id);
    stmts.revokeCurrentFamilies.run(input.now, input.installationId);
    stmts.insertFamily.run(input.familyId, input.installationId, input.now, input.refreshExpiresAt);
    stmts.insertAccess.run(input.accessHash, input.familyId, input.accessExpiresAt);
    stmts.insertRefresh.run(input.refreshHash, input.familyId, input.now, input.refreshExpiresAt);
    return { status: 'issued', replacedFamilyIds };
  });
  const rotateRows = sqlite.transaction((input: RotateRowsInput): boolean => {
    if (stmts.consumeRefresh.run(input.now, input.currentRefreshHash).changes !== 1) return false;
    stmts.deleteFamilyAccess.run(input.familyId);
    stmts.insertAccess.run(input.nextAccessHash, input.familyId, input.accessExpiresAt);
    stmts.insertRefresh.run(input.nextRefreshHash, input.familyId, input.now, input.refreshExpiresAt);
    stmts.updateFamilyRefreshExpiry.run(input.refreshExpiresAt, input.familyId);
    return true;
  });
  const revokeFamilyRows = sqlite.transaction((familyId: string, now: number): boolean => {
    return stmts.revokeFamilyById.run(now, familyId).changes === 1;
  });
  const revokeInstallationRows = sqlite.transaction((installationId: string, now: number) => {
    if (stmts.selectInstallationTarget.get(installationId) === null) return { status: 'missing' as const };
    const current = stmts.selectCurrentFamily.get(installationId);
    if (current === null) return { status: 'revoked' as const };
    if (current.refresh_expires_at <= now) return { status: 'expired' as const };
    stmts.revokeFamilyById.run(now, current.family_id);
    return { status: 'revoked' as const, familyId: current.family_id };
  });
  const cleanupRows = sqlite.transaction((now: number, retentionMs: number): void => {
    stmts.deleteExpiredAccess.run(now);
    stmts.deleteExpiredRefresh.run(now);
    stmts.deleteTerminalFamilies.run(retentionMs, now);
    stmts.deleteOrphanInstallations.run();
  });

  return {
    issue: (input) => issueRows.immediate(input),
    rotate: (input) => rotateRows.immediate(input),
    readFamily: (familyId) => {
      const row = stmts.selectFamily.get(familyId);
      return row === null ? null : storedFamily(row);
    },
    readRefresh: (tokenHash) => {
      const row = stmts.selectRefresh.get(tokenHash);
      return row === null ? null : storedRefresh(row);
    },
    loadActiveAccess: (now) => stmts.selectActiveAccess.all(now).map(storedAccessGrant),
    revokeFamily: (familyId, now) => revokeFamilyRows.immediate(familyId, now),
    revokeInstallation: (installationId, now) => revokeInstallationRows.immediate(installationId, now),
    listInstallations: (now) => stmts.selectInstallations.all().map((row) => installationSummary(row, now)),
    cleanup: (now, retentionMs) => {
      cleanupRows.immediate(now, retentionMs);
    },
  };
}
