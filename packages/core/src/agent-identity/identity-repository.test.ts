import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../db';
import { createAgentIdentityRepository } from './identity-repository';

const INSTALLATION = '0f4dcb50-d68c-4b99-8af1-da32480ddd09';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-agent-repository-'));
  roots.push(home);
  const handle = openDb({ home });
  return { handle, repo: createAgentIdentityRepository(handle.sqlite) };
};

test('issue replaces only the current family for one installation', () => {
  const { handle, repo } = fixture();
  repo.issue({
    installationId: INSTALLATION,
    target: 'opencode',
    adapterVersion: '1.2.3',
    familyId: 'family-1',
    accessHash: 'at-1',
    refreshHash: 'rt-1',
    now: 1_000,
    accessExpiresAt: 901_000,
    refreshExpiresAt: 7_776_001_000,
  });
  repo.issue({
    installationId: INSTALLATION,
    target: 'opencode',
    adapterVersion: '1.2.4',
    familyId: 'family-2',
    accessHash: 'at-2',
    refreshHash: 'rt-2',
    now: 2_000,
    accessExpiresAt: 902_000,
    refreshExpiresAt: 7_776_002_000,
  });
  expect(repo.readFamily('family-1')?.revokedAt).toBe(2_000);
  expect(repo.readFamily('family-2')?.revokedAt).toBeNull();
  handle.close();
});

test('issue cannot rebind an installation to another target or revoke its family', () => {
  const { handle, repo } = fixture();
  repo.issue({
    installationId: INSTALLATION,
    target: 'opencode',
    adapterVersion: '1.2.3',
    familyId: 'family-1',
    accessHash: 'at-1',
    refreshHash: 'rt-1',
    now: 1_000,
    accessExpiresAt: 901_000,
    refreshExpiresAt: 7_776_001_000,
  });
  expect(
    repo.issue({
      installationId: INSTALLATION,
      target: 'pi',
      adapterVersion: '1.2.4',
      familyId: 'family-2',
      accessHash: 'at-2',
      refreshHash: 'rt-2',
      now: 2_000,
      accessExpiresAt: 902_000,
      refreshExpiresAt: 7_776_002_000,
    }),
  ).toEqual({ status: 'target_mismatch' });
  expect(repo.readFamily('family-1')?.revokedAt).toBeNull();
  expect(repo.readFamily('family-2')).toBeNull();
  expect(repo.loadActiveAccess(2_000)).toEqual([expect.objectContaining({ tokenHash: 'at-1', target: 'opencode' })]);
  expect(repo.listInstallations(2_000)).toEqual([
    expect.objectContaining({ installationId: INSTALLATION, target: 'opencode' }),
  ]);
  handle.close();
});

test('rotation consumes old refresh and inserts the successor atomically', () => {
  const { handle, repo } = fixture();
  repo.issue({
    installationId: INSTALLATION,
    target: 'opencode',
    adapterVersion: '1.2.3',
    familyId: 'family-1',
    accessHash: 'at-1',
    refreshHash: 'rt-1',
    now: 1_000,
    accessExpiresAt: 901_000,
    refreshExpiresAt: 7_776_001_000,
  });
  expect(
    repo.rotate({
      familyId: 'family-1',
      currentRefreshHash: 'rt-1',
      nextAccessHash: 'at-2',
      nextRefreshHash: 'rt-2',
      now: 2_000,
      accessExpiresAt: 902_000,
      refreshExpiresAt: 7_776_002_000,
    }),
  ).toBe(true);
  expect(repo.readRefresh('rt-1')?.consumedAt).toBe(2_000);
  expect(repo.readRefresh('rt-2')).toMatchObject({ consumedAt: null, expiresAt: 7_776_002_000 });
  expect(repo.readFamily('family-1')?.refreshExpiresAt).toBe(7_776_002_000);
  expect(repo.loadActiveAccess(2_000).map(({ tokenHash }) => tokenHash)).toEqual(['at-2']);
  expect(
    repo.rotate({
      familyId: 'family-1',
      currentRefreshHash: 'rt-1',
      nextAccessHash: 'at-3',
      nextRefreshHash: 'rt-3',
      now: 2_001,
      accessExpiresAt: 902_001,
      refreshExpiresAt: 7_776_002_001,
    }),
  ).toBe(false);
  expect(repo.readRefresh('rt-3')).toBeNull();
  handle.close();
});

test('rotation does not consume a foreign refresh or mutate the requested family', () => {
  const { handle, repo } = fixture();
  const other = '1a2b3c4d-5e6f-4789-a012-3456789abcde';
  repo.issue({
    installationId: INSTALLATION,
    target: 'opencode',
    adapterVersion: '1.2.3',
    familyId: 'family-1',
    accessHash: 'at-1',
    refreshHash: 'rt-1',
    now: 1_000,
    accessExpiresAt: 901_000,
    refreshExpiresAt: 7_776_001_000,
  });
  repo.issue({
    installationId: other,
    target: 'pi',
    adapterVersion: '1.0.0',
    familyId: 'family-2',
    accessHash: 'at-2',
    refreshHash: 'rt-2',
    now: 1_000,
    accessExpiresAt: 901_000,
    refreshExpiresAt: 7_776_001_000,
  });
  expect(
    repo.rotate({
      familyId: 'family-1',
      currentRefreshHash: 'rt-2',
      nextAccessHash: 'at-3',
      nextRefreshHash: 'rt-3',
      now: 2_000,
      accessExpiresAt: 902_000,
      refreshExpiresAt: 7_776_002_000,
    }),
  ).toBe(false);
  expect(repo.readFamily('family-1')).toMatchObject({ revokedAt: null, refreshExpiresAt: 7_776_001_000 });
  expect(repo.readRefresh('rt-2')?.consumedAt).toBeNull();
  expect(repo.readRefresh('rt-3')).toBeNull();
  expect(
    repo
      .loadActiveAccess(2_000)
      .map(({ tokenHash }) => tokenHash)
      .toSorted(),
  ).toEqual(['at-1', 'at-2']);
  handle.close();
});

test('revokeInstallation reports missing, expired, and revoked without mutating expired families', () => {
  const { handle, repo } = fixture();
  const other = '1a2b3c4d-5e6f-4789-a012-3456789abcde';
  expect(repo.revokeInstallation(INSTALLATION, 1_000)).toEqual({ status: 'missing' });
  repo.issue({
    installationId: INSTALLATION,
    target: 'opencode',
    adapterVersion: '1.2.3',
    familyId: 'family-1',
    accessHash: 'at-1',
    refreshHash: 'rt-1',
    now: 1_000,
    accessExpiresAt: 901_000,
    refreshExpiresAt: 1_500,
  });
  expect(repo.revokeInstallation(INSTALLATION, 2_000)).toEqual({ status: 'expired' });
  expect(repo.readFamily('family-1')?.revokedAt).toBeNull();
  repo.issue({
    installationId: other,
    target: 'pi',
    adapterVersion: '1.0.0',
    familyId: 'family-2',
    accessHash: 'at-2',
    refreshHash: 'rt-2',
    now: 1_000,
    accessExpiresAt: 901_000,
    refreshExpiresAt: 7_776_001_000,
  });
  expect(repo.revokeInstallation(other, 2_000)).toEqual({ status: 'revoked', familyId: 'family-2' });
  expect(repo.readFamily('family-2')?.revokedAt).toBe(2_000);
  expect(repo.revokeInstallation(other, 3_000)).toEqual({ status: 'revoked' });
  handle.close();
});

test('cleanup deletes expired access immediately and terminal rows after retention', () => {
  const { handle, repo } = fixture();
  repo.issue({
    installationId: INSTALLATION,
    target: 'opencode',
    adapterVersion: '1.2.3',
    familyId: 'family-1',
    accessHash: 'at-1',
    refreshHash: 'rt-1',
    now: 1_000,
    accessExpiresAt: 1_500,
    refreshExpiresAt: 3_000,
  });
  repo.cleanup(2_000, 10_000);
  expect(repo.loadActiveAccess(2_000)).toEqual([]);
  expect(repo.readRefresh('rt-1')?.expiresAt).toBe(3_000);
  expect(repo.readFamily('family-1')).not.toBeNull();
  repo.revokeFamily('family-1', 2_000);
  repo.cleanup(3_000, 10_000);
  expect(repo.readRefresh('rt-1')).toBeNull();
  expect(repo.readFamily('family-1')).not.toBeNull();
  repo.cleanup(12_999, 10_000);
  expect(repo.readFamily('family-1')).not.toBeNull();
  repo.cleanup(13_000, 10_000);
  expect(repo.readFamily('family-1')).toBeNull();
  expect(repo.listInstallations(13_000)).toEqual([]);
  handle.close();
});

test('cleanup deletes expired unrevoked families after the refresh retention window', () => {
  const { handle, repo } = fixture();
  repo.issue({
    installationId: INSTALLATION,
    target: 'opencode',
    adapterVersion: '1.2.3',
    familyId: 'family-1',
    accessHash: 'at-1',
    refreshHash: 'rt-1',
    now: 1_000,
    accessExpiresAt: 1_500,
    refreshExpiresAt: 3_000,
  });
  repo.cleanup(12_999, 10_000);
  expect(repo.readFamily('family-1')?.revokedAt).toBeNull();
  expect(repo.listInstallations(12_999)).toEqual([
    expect.objectContaining({ installationId: INSTALLATION, authorization: 'expired' }),
  ]);
  repo.cleanup(13_000, 10_000);
  expect(repo.readFamily('family-1')).toBeNull();
  expect(repo.listInstallations(13_000)).toEqual([]);
  handle.close();
});
