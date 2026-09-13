import { expect, test } from 'bun:test';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { acquireProcessFileLock } from '@aio-proxy/core';

import * as grokPublic from '../grok';
import { grokPaths, readGrokFile, replaceGrokFile } from '../grok/files';
import { configureGrok, removeGrok, removeGrokForTest } from '../grok/grok';
import * as authPublic from './index';
import { createGrokProcessHarness, type HelperChild } from './process-fixture';

const credentialPath = (root: string) => join(root, 'aio-proxy', 'credential.json');

type CredentialMeta = {
  readonly revision: number;
  readonly status: string;
  readonly refreshStartedAt?: number;
  readonly deliveredBy?: string;
  readonly accessToken: string;
  readonly refreshToken: string;
};

async function readMeta(root: string): Promise<CredentialMeta> {
  return JSON.parse(await readFile(credentialPath(root), 'utf8')) as CredentialMeta;
}

function parseAccessToken(stdout: string): string {
  return (JSON.parse(stdout) as { access_token: string }).access_token;
}

function observationFields(value: {
  readonly revision?: number;
  readonly deliveredBy?: string;
  readonly lockOwner?: string;
}) {
  return {
    revision: value.revision,
    deliveredBy: value.deliveredBy,
    lockOwner: value.lockOwner,
  };
}

async function killChild(child: HelperChild): Promise<number> {
  try {
    child.process.kill(9);
  } catch {}
  return child.exit;
}

test('process-fixture is not exported from product barrels', () => {
  expect('spawnHelperForTest' in authPublic).toBe(false);
  expect('createGrokProcessHarness' in authPublic).toBe(false);
  expect('spawnHelperForTest' in grokPublic).toBe(false);
});

test('two real helpers share one refresh rotation when the first response is frozen', async () => {
  const h = await createGrokProcessHarness();
  try {
    const before = await readMeta(h.root);
    h.holdRefresh();
    const first = h.spawnHelperForTest(h.input);
    await h.refreshEntered;
    const second = h.spawnHelperForTest(h.input);
    const seen = await second.observed;
    expect(observationFields(seen)).toEqual({
      revision: before.revision,
      deliveredBy: before.deliveredBy,
      lockOwner: seen.lockOwner,
    });
    expect(seen.lockOwner).toBeDefined();
    expect(JSON.stringify(seen)).not.toContain(before.accessToken);
    expect(JSON.stringify(seen)).not.toContain(before.refreshToken);
    h.releaseRefresh();
    const [a, b] = await Promise.all([first.stdout, second.stdout]);
    expect(parseAccessToken(a)).toBe(parseAccessToken(b));
    expect(h.rotationCount).toBe(1);
    expect(h.refreshRequestCount).toBe(1);
    expect((await readMeta(h.root)).revision).toBe(before.revision + 1);
    expect(await first.exit).toBe(0);
    expect(await second.exit).toBe(0);
    expect(h.identity.authenticateAccessToken(parseAccessToken(a)).status).toBe('valid');
  } finally {
    await h.cleanup();
  }
});

test('after-credential-save lets B observe revision N+1 without deliveredBy before A writes stdout', async () => {
  const h = await createGrokProcessHarness();
  try {
    const before = await readMeta(h.root);
    const first = h.spawnHelperForTest(h.input, { gate: 'after-credential-save' });
    await first.afterSave;
    const saved = await readMeta(h.root);
    expect(saved.revision).toBe(before.revision + 1);
    expect(saved.deliveredBy).toBeUndefined();
    expect(saved.status).toBe('ready');
    const second = h.spawnHelperForTest(h.input);
    const seen = await second.observed;
    expect(seen.revision).toBe(before.revision + 1);
    expect(seen.deliveredBy).toBeUndefined();
    expect(seen.lockOwner).toBeDefined();
    first.release();
    const [a, b] = await Promise.all([first.stdout, second.stdout]);
    expect(await first.exit).toBe(0);
    expect(await second.exit).toBe(0);
    expect(h.rotationCount).toBe(1);
    expect(parseAccessToken(a)).toBe(parseAccessToken(b));
    expect(h.identity.authenticateAccessToken(parseAccessToken(a)).status).toBe('valid');
  } finally {
    await h.cleanup();
  }
});

test('a helper started after A completes must refresh', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input);
    expect(await first.exit).toBe(0);
    const second = h.spawnHelperForTest(h.input);
    expect(await second.exit).toBe(0);
    expect(h.rotationCount).toBe(2);
    expect(parseAccessToken(await first.stdout)).not.toBe(parseAccessToken(await second.stdout));
  } finally {
    await h.cleanup();
  }
});

test('revoke between helpers sends a normal helper through device and a silent helper nonzero', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input);
    expect(await first.exit).toBe(0);
    expect(h.identity.revokeInstallation(h.input.installationId)).toBe('revoked');
    const refreshes = h.refreshRequestCount;
    const silent = h.spawnHelperForTest({ ...h.input, expired: true });
    expect(await silent.exit).not.toBe(0);
    expect(await silent.stdout).not.toContain('access_token');
    expect(h.refreshRequestCount).toBeGreaterThan(refreshes);
    const normal = h.spawnHelperForTest(h.input);
    expect(await normal.exit).toBe(0);
    expect(h.identity.authenticateAccessToken(parseAccessToken(await normal.stdout)).status).toBe('valid');
  } finally {
    await h.cleanup();
  }
}, 20_000);

test('completion-mark write failure exits nonzero, recovers the lock, and keeps the new refresh token', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input, { failDeliveredByWrite: true });
    expect(await first.exit).not.toBe(0);
    const saved = await readMeta(h.root);
    expect(saved.status).toBe('ready');
    expect(saved.deliveredBy).toBeUndefined();
    expect(saved.refreshToken).not.toBe(h.issued.refreshToken);
    const recovered = await acquireProcessFileLock(join(h.root, '.aio-proxy.lock'), AbortSignal.timeout(2_000));
    await recovered.release();
    expect(await first.stdout).toBeDefined();
  } finally {
    await h.cleanup();
  }
});

test('kill before stdout exits nonzero, recovers the lock, and keeps the new refresh token', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input, { gate: 'before-stdout' });
    await first.afterSave;
    const saved = await readMeta(h.root);
    expect(saved.status).toBe('ready');
    expect(saved.refreshToken).not.toBe(h.issued.refreshToken);
    expect(await killChild(first)).not.toBe(0);
    expect(await first.stdout).not.toContain('access_token');
    const recovered = await acquireProcessFileLock(join(h.root, '.aio-proxy.lock'), AbortSignal.timeout(2_000));
    await recovered.release();
    const next = h.spawnHelperForTest(h.input);
    expect(await next.exit).toBe(0);
    expect((await readMeta(h.root)).refreshToken).not.toBe(h.issued.refreshToken);
    expect((await readMeta(h.root)).refreshToken).not.toBe(saved.refreshToken);
  } finally {
    await h.cleanup();
  }
});

test('kill after output before the completion mark exits nonzero without treating stdout AT as valid', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input, { pauseAfterStdout: true });
    await first.afterStdout;
    const saved = await readMeta(h.root);
    expect(saved.deliveredBy).toBeUndefined();
    expect(await killChild(first)).not.toBe(0);
    await first.stdout;
    const recovered = await acquireProcessFileLock(join(h.root, '.aio-proxy.lock'), AbortSignal.timeout(2_000));
    await recovered.release();
    expect((await readMeta(h.root)).refreshToken).toBe(saved.refreshToken);
  } finally {
    await h.cleanup();
  }
});

test('after-delivery-before-release reuses deliveredBy=A with one rotation and valid tokens', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input, { gate: 'after-delivery-before-release' });
    await first.deliveryCommitted;
    const committed = await readMeta(h.root);
    expect(committed.deliveredBy).toBeDefined();
    const second = h.spawnHelperForTest(h.input);
    const seen = await second.observed;
    expect(seen.lockOwner).toBe(committed.deliveredBy);
    expect(seen.deliveredBy).toBe(committed.deliveredBy);
    first.release();
    const [a, b] = await Promise.all([first.stdout, second.stdout]);
    expect(await first.exit).toBe(0);
    expect(await second.exit).toBe(0);
    expect(h.rotationCount).toBe(1);
    expect(parseAccessToken(a)).toBe(parseAccessToken(b));
    expect(h.identity.authenticateAccessToken(parseAccessToken(a)).status).toBe('valid');
  } finally {
    await h.cleanup();
  }
});

test('C reuses first, then B still reuses with deliveredBy=C', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input, { gate: 'after-delivery-before-release' });
    await first.deliveryCommitted;
    const second = h.spawnHelperForTest(h.input, { holdAfterObservation: true });
    const seen = await second.observed;
    expect(seen.lockOwner).toBeDefined();
    expect(seen.deliveredBy).toBe(seen.lockOwner);
    const third = h.spawnHelperForTest(h.input);
    const thirdSeen = await third.observed;
    expect(thirdSeen.lockOwner).toBe(seen.lockOwner);
    expect(thirdSeen.deliveredBy).toBe(seen.lockOwner);
    first.release();
    expect(await third.exit).toBe(0);
    const afterC = await readMeta(h.root);
    expect(afterC.deliveredBy).toBeDefined();
    expect(afterC.deliveredBy).not.toBe(seen.lockOwner);
    second.release();
    expect(await second.exit).toBe(0);
    expect(h.rotationCount).toBe(1);
    expect(parseAccessToken(await second.stdout)).toBe(parseAccessToken(await third.stdout));
    expect((await readMeta(h.root)).deliveredBy).toBeDefined();
    expect((await readMeta(h.root)).deliveredBy).not.toBe(seen.lockOwner);
  } finally {
    await h.cleanup();
  }
});

test('an independent helper after lock release refreshes instead of reusing', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input, { gate: 'after-delivery-before-release' });
    await first.deliveryCommitted;
    first.release();
    expect(await first.exit).toBe(0);
    const second = h.spawnHelperForTest(h.input);
    expect(await second.exit).toBe(0);
    expect(h.rotationCount).toBe(2);
  } finally {
    await h.cleanup();
  }
});

test('a dead lock holder cannot be reused through a stale deliveredBy owner', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input);
    expect(await first.exit).toBe(0);
    const ready = await readMeta(h.root);
    await writeFile(
      join(h.root, '.aio-proxy.lock'),
      JSON.stringify({ pid: 999_999, owner: ready.deliveredBy, createdAt: Date.now() }),
      { mode: 0o600 },
    );
    await chmod(join(h.root, '.aio-proxy.lock'), 0o600);
    const second = h.spawnHelperForTest(h.input);
    expect(await second.exit).toBe(0);
    expect(h.rotationCount).toBe(2);
  } finally {
    await h.cleanup();
  }
});

test('a lost refresh response keeps the journal refreshing and replays the same family within 30s', async () => {
  const h = await createGrokProcessHarness();
  try {
    h.dropNextRefreshResponse();
    const lost = h.spawnHelperForTest(h.input);
    expect(await lost.exit).not.toBe(0);
    const journal = await readMeta(h.root);
    expect(journal.status).toBe('refreshing');
    expect(journal.refreshToken).toBe(h.issued.refreshToken);
    const startedAt = journal.refreshStartedAt;
    expect(startedAt).toBeDefined();
    expect(h.rotationCount).toBe(1);
    h.holdRefresh();
    const retry = h.spawnHelperForTest(h.input);
    await h.refreshEntered;
    expect((await readMeta(h.root)).refreshStartedAt).toBe(startedAt);
    h.releaseRefresh();
    expect(await retry.exit).toBe(0);
    expect(h.rotationCount).toBe(1);
    expect(h.identity.authenticateAccessToken(parseAccessToken(await retry.stdout)).status).toBe('valid');
  } finally {
    await h.cleanup();
  }
});

test('after 30s a silent helper does not send the old refresh token and a normal helper may device', async () => {
  const h = await createGrokProcessHarness();
  try {
    h.dropNextRefreshResponse();
    const lost = h.spawnHelperForTest(h.input);
    expect(await lost.exit).not.toBe(0);
    const journal = await readMeta(h.root);
    const startedAt = journal.refreshStartedAt!;
    const requests = h.refreshRequestCount;
    h.setNow(startedAt + 31_000);
    const silent = h.spawnHelperForTest({ ...h.input, expired: true }, { now: startedAt + 31_000 });
    expect(await silent.exit).not.toBe(0);
    expect(h.refreshRequestCount).toBe(requests);
    expect(await silent.stdout).not.toContain('access_token');
    const normal = h.spawnHelperForTest(h.input, { now: startedAt + 31_000 });
    expect(await normal.exit).toBe(0);
    expect(h.identity.authenticateAccessToken(parseAccessToken(await normal.stdout)).status).toBe('valid');
  } finally {
    await h.cleanup();
  }
}, 20_000);

test('kill after refreshing is written and before the response keeps replay', async () => {
  const h = await createGrokProcessHarness();
  try {
    h.holdRefresh();
    const first = h.spawnHelperForTest(h.input);
    await h.refreshEntered;
    expect((await readMeta(h.root)).status).toBe('refreshing');
    expect(await killChild(first)).not.toBe(0);
    h.releaseRefresh();
    const next = h.spawnHelperForTest(h.input);
    expect(await next.exit).toBe(0);
    expect(h.rotationCount).toBe(1);
  } finally {
    await h.cleanup();
  }
});

test('kill after the server issued and before credential rename keeps replay', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input, { pauseBeforeReadyRename: true });
    await first.beforeRename;
    expect((await readMeta(h.root)).status).toBe('refreshing');
    expect((await readMeta(h.root)).refreshToken).toBe(h.issued.refreshToken);
    expect(h.rotationCount).toBe(1);
    expect(await killChild(first)).not.toBe(0);
    const next = h.spawnHelperForTest(h.input);
    expect(await next.exit).toBe(0);
    expect(h.rotationCount).toBe(1);
  } finally {
    await h.cleanup();
  }
});

test('kill after the credential is durable and before stdout issues a new refresh token next', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input, { gate: 'after-credential-save' });
    await first.afterSave;
    const saved = await readMeta(h.root);
    expect(saved.status).toBe('ready');
    expect(saved.refreshToken).not.toBe(h.issued.refreshToken);
    expect(await killChild(first)).not.toBe(0);
    const next = h.spawnHelperForTest(h.input);
    expect(await next.exit).toBe(0);
    expect(h.rotationCount).toBe(2);
    expect((await readMeta(h.root)).refreshToken).not.toBe(saved.refreshToken);
    expect((await readMeta(h.root)).refreshToken).not.toBe(h.issued.refreshToken);
  } finally {
    await h.cleanup();
  }
});

test('closing stdout early does not roll back the saved credential', async () => {
  const h = await createGrokProcessHarness();
  try {
    const first = h.spawnHelperForTest(h.input, { gate: 'after-credential-save' });
    await first.afterSave;
    const saved = await readMeta(h.root);
    await first.cancelStdout();
    first.release();
    expect(await first.exit).not.toBe(0);
    const after = await readMeta(h.root);
    expect(after.refreshToken).toBe(saved.refreshToken);
    expect(after.status).toBe('ready');
  } finally {
    await h.cleanup();
  }
});

test('a live holder blocks a silent helper within the five second budget', async () => {
  const h = await createGrokProcessHarness();
  try {
    const holder = h.spawnHelperForTest(h.input, { gate: 'after-delivery-before-release' });
    await holder.deliveryCommitted;
    const started = Date.now();
    const silent = h.spawnHelperForTest({ ...h.input, expired: true });
    expect(await silent.exit).not.toBe(0);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(6_000);
    expect(await silent.stdout).not.toContain('access_token');
    holder.release();
    expect(await holder.exit).toBe(0);
  } finally {
    await h.cleanup();
  }
}, 15_000);

test('killing a live holder lets a new process recover the lock via process identity', async () => {
  const h = await createGrokProcessHarness();
  try {
    const holder = h.spawnHelperForTest(h.input, { gate: 'after-delivery-before-release' });
    await holder.deliveryCommitted;
    expect(await killChild(holder)).not.toBe(0);
    const started = Date.now();
    const next = h.spawnHelperForTest(h.input);
    expect(await next.exit).toBe(0);
    expect(Date.now() - started).toBeLessThan(3_000);
  } finally {
    await h.cleanup();
  }
});

test('a replaced lock inode cannot be unlinked by the former owner', async () => {
  const h = await createGrokProcessHarness();
  try {
    const holder = h.spawnHelperForTest(h.input, { gate: 'after-delivery-before-release' });
    await holder.deliveryCommitted;
    const lockPath = join(h.root, '.aio-proxy.lock');
    await unlink(lockPath);
    const replacement = await acquireProcessFileLock(lockPath, AbortSignal.timeout(2_000));
    holder.release();
    await holder.exit;
    expect(JSON.parse(await readFile(lockPath, 'utf8')).owner).toBe(replacement.owner);
    await replacement.release();
  } finally {
    await h.cleanup();
  }
});

test('an external rewrite before a config write is detected', async () => {
  const h = await createGrokProcessHarness();
  try {
    const paths = grokPaths(h.root);
    const expected = await readGrokFile(paths.config);
    await expect(
      replaceGrokFile(
        paths.config,
        'theme = "owned"\n',
        expected,
        {
          deadline: Date.now() + 5_000,
          signal: AbortSignal.timeout(5_000),
        },
        async () => {},
        {
          beforeRename: async () => {
            await writeFile(paths.config, `${expected?.text ?? ''}\n# external\n`);
          },
        },
      ),
    ).rejects.toThrow(/changed during update/);
    expect(await readFile(paths.config, 'utf8')).toContain('external');
  } finally {
    await h.cleanup();
  }
});

test('remove that already wrote removing does not let a later helper issue tokens', async () => {
  const h = await createGrokProcessHarness();
  try {
    const paused = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const removing = removeGrokForTest(h.root, h.input.adapterVersion, h.deps, {
      failpoint: async (point) => {
        if (point === 'removing') {
          paused.resolve();
          await resume.promise;
        }
      },
    });
    await paused.promise;
    const helper = h.spawnHelperForTest(h.input);
    await helper.observed.catch(() => undefined);
    resume.resolve();
    await removing;
    expect(await helper.exit).not.toBe(0);
    expect(await helper.stdout).not.toContain('access_token');
    expect(h.rotationCount).toBe(0);
  } finally {
    await h.cleanup();
  }
});

test('helper-first then remove revokes the family, clears the credential, and requires a new UUID', async () => {
  const h = await createGrokProcessHarness();
  try {
    const helper = h.spawnHelperForTest(h.input);
    expect(await helper.exit).toBe(0);
    const token = parseAccessToken(await helper.stdout);
    expect(h.identity.authenticateAccessToken(token).status).toBe('valid');
    const oldId = h.input.installationId;
    const removed = await removeGrok(h.root, h.input.adapterVersion, h.deps);
    expect(removed.revokeStatus).toBe('revoked');
    expect(h.identity.authenticateAccessToken(token).status).toBe('invalid');
    expect(await Bun.file(credentialPath(h.root)).exists()).toBe(false);
    const next = await configureGrok(
      { root: h.root, endpoint: h.endpoint, executable: '/opt/bin/aio-proxy', adapterVersion: h.input.adapterVersion },
      h.deps,
    );
    expect(next.marker.installationId).not.toBe(oldId);
    const stale = h.spawnHelperForTest({ ...h.input, installationId: oldId });
    expect(await stale.exit).not.toBe(0);
    const fresh = h.spawnHelperForTest({ ...h.input, installationId: next.marker.installationId, expired: true });
    expect(await fresh.exit).not.toBe(0);
  } finally {
    await h.cleanup();
  }
});

test('cleanup breakpoints keep unknown files and only clear this installation', async () => {
  const h = await createGrokProcessHarness();
  try {
    const notes = join(h.root, 'aio-proxy', 'notes.txt');
    await writeFile(notes, 'keep me\n', { mode: 0o600 });
    await expect(
      removeGrokForTest(h.root, h.input.adapterVersion, h.deps, {
        failpoint: (point) => {
          if (point === 'cleanup_complete') throw new Error('crash after restored journal');
        },
      }),
    ).rejects.toThrow(/restored journal/);
    expect(await readFile(notes, 'utf8')).toBe('keep me\n');
    expect(JSON.parse(await readFile(join(h.root, 'aio-proxy', 'ownership.json'), 'utf8')).cleanupComplete).toBe(true);
    const finished = await removeGrokForTest(h.root, h.input.adapterVersion, h.deps, {
      failpoint: (point) => {
        if (point === 'marker_removed') throw new Error('crash after marker delete');
      },
    });
    expect(finished.retainedFiles).toContain('notes.txt');
    expect(await readFile(notes, 'utf8')).toBe('keep me\n');
    expect(await Bun.file(join(h.root, 'aio-proxy', '.aio-proxy-managed.json')).exists()).toBe(true);
    expect(await Bun.file(join(h.root, 'aio-proxy', 'ownership.json')).exists()).toBe(true);
  } finally {
    await h.cleanup();
  }
});

test('unknown ownership format cannot use the completed-removal recovery path', async () => {
  const h = await createGrokProcessHarness();
  try {
    await expect(
      removeGrokForTest(h.root, h.input.adapterVersion, h.deps, {
        failpoint: (point) => {
          if (point === 'marker_removed') throw new Error('stop before ownership delete');
        },
      }),
    ).rejects.toThrow(/ownership delete/);
    await writeFile(
      join(h.root, 'aio-proxy', 'ownership.json'),
      `${JSON.stringify({
        format: 2,
        agent: 'grok',
        installationId: h.input.installationId,
        endpoint: h.endpoint,
        status: 'removing',
        cleanupComplete: true,
        revokeStatus: 'revoked',
        leaves: [],
        createdTables: [],
      })}\n`,
      { mode: 0o600 },
    );
    await chmod(join(h.root, 'aio-proxy', 'ownership.json'), 0o600);
    await expect(removeGrok(h.root, h.input.adapterVersion, h.deps)).rejects.toThrow(/already exists/);
    expect(await Bun.file(join(h.root, 'aio-proxy', 'ownership.json')).exists()).toBe(true);
  } finally {
    await h.cleanup();
  }
});
