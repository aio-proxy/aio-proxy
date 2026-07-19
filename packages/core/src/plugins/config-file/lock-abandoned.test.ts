import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";

import { AtomicConfigCommitUncertainError, AtomicConfigFile, AtomicConfigLockReleaseError } from ".";
import { ageLockWithUnavailableIdentity, fixture } from "./test-support";

describe("AtomicConfigFile", () => {
  test("a lock cleanup failure lets the same process immediately recover its exact abandoned owner", async () => {
    const { path } = fixture("{}\n");
    const lockPath = `${path}.lock`;
    const realUnlink = fsPromises.unlink.bind(fsPromises);
    let failed = false;
    const unlink = spyOn(fsPromises, "unlink").mockImplementation(async (target) => {
      if (target === lockPath && !failed) {
        failed = true;
        throw new Error("release failed");
      }
      return realUnlink(target);
    });

    try {
      await expect(
        new AtomicConfigFile(path).replace((current) => ({ ...current, committed: true })),
      ).rejects.toBeInstanceOf(AtomicConfigLockReleaseError);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ committed: true });
      expect(existsSync(lockPath)).toBe(true);

      const abandonedLock = readFileSync(lockPath, "utf8");
      const controller = new AbortController();
      const recovery = new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }), {
        signal: controller.signal,
      });
      try {
        await expect(
          Promise.race([
            recovery,
            Bun.sleep(500).then(() => {
              throw new Error("exact abandoned config owner was not recovered immediately");
            }),
          ]),
        ).resolves.toBeUndefined();
      } finally {
        controller.abort(new Error("test cleanup"));
        await recovery.catch(() => {});
      }
      expect(abandonedLock).toContain(`"pid":${process.pid}`);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ committed: true, recovered: true });
    } finally {
      unlink.mockRestore();
    }
  });

  test("abandoned-owner recovery never unlinks a replacement lock", async () => {
    const { path } = fixture("{}\n");
    const lockPath = `${path}.lock`;
    const realUnlink = fsPromises.unlink.bind(fsPromises);
    let failed = false;
    const unlink = spyOn(fsPromises, "unlink").mockImplementation(async (target) => {
      if (target === lockPath && !failed) {
        failed = true;
        throw new Error("release failed");
      }
      return realUnlink(target);
    });

    try {
      await expect(
        new AtomicConfigFile(path).replace((current) => ({ ...current, committed: true })),
      ).rejects.toBeInstanceOf(AtomicConfigLockReleaseError);
      unlinkSync(lockPath);
      const replacement = JSON.stringify({ pid: process.pid, owner: "replacement", createdAt: Date.now() });
      writeFileSync(lockPath, replacement);

      const controller = new AbortController();
      const blocked = new AtomicConfigFile(path).replace((current) => ({ ...current, stolen: true }), {
        signal: controller.signal,
      });
      await Bun.sleep(100);
      controller.abort(new Error("replacement remains active"));
      await expect(blocked).rejects.toThrow("replacement remains active");

      expect(readFileSync(lockPath, "utf8")).toBe(replacement);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ committed: true });
    } finally {
      unlink.mockRestore();
    }
  });

  test("a stale former owner never rolls back over a replacement config after verify", async () => {
    const { path } = fixture("{}\n");
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const update = new AtomicConfigFile(path).replace((current) => ({ ...current, candidate: true }), {
      async verify() {
        entered();
        await paused;
        throw new Error("verify failed");
      },
    });
    await didEnter;

    const lockPath = `${path}.lock`;
    ageLockWithUnavailableIdentity(lockPath);
    let finishReplacement!: () => void;
    const replacementCanFinish = new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
    let replacementCommitted!: () => void;
    const replacementDidCommit = new Promise<void>((resolve) => {
      replacementCommitted = resolve;
    });
    const replacement = new AtomicConfigFile(path).replace(() => ({ newer: true }), {
      async verify() {
        replacementCommitted();
        await replacementCanFinish;
      },
    });
    await replacementDidCommit;
    resume();

    await expect(update).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ newer: true });
    finishReplacement();
    await replacement;
  });
});
