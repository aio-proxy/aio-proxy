import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

import { AtomicConfigFile } from '.';
import { ageLockWithUnavailableIdentity, fixture } from './test-support';

describe('AtomicConfigFile', () => {
  test('a stale former owner cannot rename or release a replacement lock after it resumes', async () => {
    const { path } = fixture('{}\n');
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const update = new AtomicConfigFile(path).replace(async (current) => {
      entered();
      await paused;
      return { ...current, staleOwnerWrite: true };
    });
    await didEnter;

    const lockPath = `${path}.lock`;
    ageLockWithUnavailableIdentity(lockPath);
    let finishReplacement!: () => void;
    const replacementCanFinish = new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
    let replacementEntered!: () => void;
    const replacementDidEnter = new Promise<void>((resolve) => {
      replacementEntered = resolve;
    });
    const replacement = new AtomicConfigFile(path).replace(async (current) => {
      replacementEntered();
      await replacementCanFinish;
      return { ...current, replacement: true };
    });
    await replacementDidEnter;
    const replacementOwner = JSON.parse(readFileSync(lockPath, 'utf8')).owner;
    resume();

    await expect(update).rejects.toThrow('Config lock ownership lost');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
    expect(JSON.parse(readFileSync(lockPath, 'utf8')).owner).toBe(replacementOwner);
    finishReplacement();
    await replacement;
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ replacement: true });
  });

  test('a same-object mutation does not hold the recovery fence for its whole callback', async () => {
    const { path } = fixture('{}\n');
    const config = new AtomicConfigFile(path);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = config.transaction(async (current) => {
      entered();
      await paused;
      return { next: current, result: 'first' };
    });
    await didEnter;
    ageLockWithUnavailableIdentity(`${path}.lock`);

    let secondEntered = false;
    const second = config.replace((current) => {
      secondEntered = true;
      return { ...current, second: true };
    });
    const secondResult = second.then(() => undefined);
    const deadline = Date.now() + 2_000;
    while (!secondEntered) {
      if (Date.now() >= deadline) throw new Error('replacement did not enter');
      await Bun.sleep(5);
    }

    resume();
    await expect(first).rejects.toThrow('Config lock ownership lost');
    await secondResult;
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ second: true });
  });

  test('a verified commit keeps its recovery fence through afterCommit side effects', async () => {
    const { path } = fixture('{}\n');
    let resumeAfterCommit!: () => void;
    const afterCommitPaused = new Promise<void>((resolve) => (resumeAfterCommit = resolve));
    let afterCommitEntered!: () => void;
    const didEnterAfterCommit = new Promise<void>((resolve) => (afterCommitEntered = resolve));
    let sideEffectApplied = false;
    const first = new AtomicConfigFile(path).replace((current) => ({ ...current, first: true }), {
      afterCommit: async () => {
        afterCommitEntered();
        await afterCommitPaused;
        sideEffectApplied = true;
      },
    });
    await didEnterAfterCommit;

    const lockPath = `${path}.lock`;
    ageLockWithUnavailableIdentity(lockPath);
    let replacementEntered = false;
    let replacementDidEnter!: () => void;
    const didEnterReplacement = new Promise<void>((resolve) => (replacementDidEnter = resolve));
    const replacement = new AtomicConfigFile(path).replace((current) => {
      replacementEntered = true;
      replacementDidEnter();
      return { ...current, replacement: true };
    });

    try {
      await Bun.sleep(100);
      expect(replacementEntered).toBe(false);
      resumeAfterCommit();
      await first;
      await didEnterReplacement;
      expect(sideEffectApplied).toBe(true);
      await replacement;
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ first: true, replacement: true });
    } finally {
      resumeAfterCommit();
      await Promise.allSettled([first, replacement]);
    }
  });
});

describe('AtomicConfigFile cleanup fencing', () => {
  test('a lost recovery fence before cleanup rolls back the verified candidate and skips side effects', async () => {
    const { dir, path } = fixture('{}\n');
    let cleanupApplied = false;
    const verified: unknown[] = [];
    const update = new AtomicConfigFile(path).replace((current) => ({ ...current, candidate: true }), {
      verify: async (candidate) => {
        verified.push(candidate);
      },
      beforeCommit: async (_candidate, assertOwnership) => {
        const prefix = `${basename(path)}.lock.recovery.`;
        const marker = readdirSync(dir).find((name) => name.startsWith(prefix));
        if (marker === undefined) throw new Error('recovery fence marker missing');
        unlinkSync(join(dir, marker));
        await assertOwnership();
      },
      afterCommit: async () => {
        cleanupApplied = true;
      },
    });

    await expect(update).rejects.toThrow('Lock recovery ownership lost');
    expect(cleanupApplied).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({});
    expect(verified).toEqual([{ candidate: true }, {}]);
  });
});
