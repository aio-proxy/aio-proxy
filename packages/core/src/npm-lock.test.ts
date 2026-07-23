import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NpmLockError } from "./error";
import { acquireNpmInstallLock } from "./npm-lock";

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

describe.serial("acquireNpmInstallLock", () => {
  test("Given ps is unavailable When lock owner is alive Then lock is not recycled", async () => {
    // Given
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-live-lock-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    const lockText = JSON.stringify({
      pid: process.pid,
      createdAt: Date.now(),
      starttime: "different-starttime",
      version: 1,
    });
    writeFileSync(lockPath, lockText, { flag: "wx" });
    const originalSpawn = Bun.spawn;
    Bun.spawn = () => {
      throw new Error("ps unavailable");
    };

    try {
      // When
      const result = acquireNpmInstallLock("aio-proxy-live-lock-provider", cacheDir);

      // Then
      await expect(result).rejects.toBeInstanceOf(NpmLockError);
      expect(readFileSync(lockPath, "utf8")).toBe(lockText);
    } finally {
      Bun.spawn = originalSpawn;
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("Given a fresh partial lock record When contending Then it receives a write grace period", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-partial-lock-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    writeFileSync(lockPath, "", { flag: "wx" });
    let acquired = false;
    const pending = acquireNpmInstallLock("partial-lock-provider", cacheDir).then((lock) => {
      acquired = true;
      return lock;
    });

    await Bun.sleep(100);
    expect(acquired).toBe(false);
    expect(readFileSync(lockPath, "utf8")).toBe("");
    rmSync(lockPath);
    const lock = await pending;
    await lock.release();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("Given unavailable identity and a live PID When heartbeat is stale Then the lock is recovered", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-reused-pid-lock-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: 0,
        starttime: "unavailable",
        version: 1,
      }),
      { flag: "wx" },
    );
    utimesSync(lockPath, new Date(0), new Date(0));

    const pending = acquireNpmInstallLock("reused-pid-provider", cacheDir);
    let lock: Awaited<typeof pending> | undefined;
    try {
      lock = await Promise.race([
        pending,
        Bun.sleep(500).then(() => {
          throw new Error("stale npm lock with unavailable identity was not recovered");
        }),
      ]);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      if (lock === undefined) rmSync(lockPath, { force: true });
      lock ??= await pending.catch(() => undefined);
      await lock?.release();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("Given matching live identity and a stale heartbeat When contending Then the owner is preserved", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-stale-live-lock-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    const first = await acquireNpmInstallLock("stale-live-provider", cacheDir);
    utimesSync(lockPath, new Date(0), new Date(0));

    await expect(acquireNpmInstallLock("stale-live-provider", cacheDir, { waitMs: 100 })).rejects.toBeInstanceOf(
      NpmLockError,
    );
    await expect(first.withOwnership(async () => "owned")).resolves.toBe("owned");
    expect(existsSync(lockPath)).toBe(true);

    await first.release();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("Given a stale decision When the owner refreshes heartbeat Then recovery preserves the owner", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-refresh-during-recovery-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    const pausedPath = join(cacheDir, "identity-paused");
    const resumePath = join(cacheDir, "identity-resume");
    const first = await acquireNpmInstallLock("refresh-during-recovery-provider", cacheDir);
    utimesSync(lockPath, new Date(0), new Date(0));
    const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], { stdout: "pipe" });
    const starttime = new TextDecoder().decode(ps.stdout).trim();
    const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
    const originalSpawn = mutableBun.spawn;
    let calls = 0;
    mutableBun.spawn = (() => {
      calls += 1;
      const stdout = new ReadableStream<Uint8Array>({
        async start(controller) {
          if (calls === 3) {
            writeFileSync(pausedPath, "paused");
            await waitForFile(resumePath);
          }
          controller.enqueue(new TextEncoder().encode(`${starttime}\n`));
          controller.close();
        },
      });
      return { stdout, exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    let replacement: Awaited<ReturnType<typeof acquireNpmInstallLock>> | undefined;
    const pending = acquireNpmInstallLock("refresh-during-recovery-provider", cacheDir).then((lock) => {
      replacement = lock;
      return lock;
    });
    try {
      await waitForFile(pausedPath);
      const fresh = new Date();
      utimesSync(lockPath, fresh, fresh);
      writeFileSync(resumePath, "resume");
      await Bun.sleep(100);
      await expect(first.withOwnership(async () => undefined)).resolves.toBeUndefined();
      expect(replacement).toBeUndefined();
      await first.release();
      replacement = await pending;
      await replacement.release();
    } finally {
      mutableBun.spawn = originalSpawn;
      writeFileSync(resumePath, "resume");
      await first.release().catch(() => {});
      if (replacement === undefined) replacement = await pending.catch(() => undefined);
      await replacement?.release().catch(() => {});
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("Given concurrent stale-lock recovery When owners run Then only one lock is active", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-stale-lock-race-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, createdAt: Date.now(), starttime: "dead", version: 1 }), {
      flag: "wx",
    });
    let active = 0;
    let maximum = 0;

    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const lock = await acquireNpmInstallLock("stale-lock-race-provider", cacheDir, { waitMs: 10_000 });
        active += 1;
        maximum = Math.max(maximum, active);
        await Bun.sleep(10);
        active -= 1;
        await lock.release();
      }),
    );
    expect(maximum).toBe(1);
    rmSync(cacheDir, { recursive: true, force: true });
  }, 15_000);

  test("Given release paused after compare When a replacement acquires Then the old owner cannot unlink it", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-release-race-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    const pausedPath = join(cacheDir, "release-paused");
    const resumePath = join(cacheDir, "release-resume");
    const first = await acquireNpmInstallLock("release-race-provider", cacheDir);
    const realRm = fsPromises.rm.bind(fsPromises);
    let intercepted = false;
    const rm = spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (target === lockPath && !intercepted) {
        intercepted = true;
        writeFileSync(pausedPath, "paused");
        await waitForFile(resumePath);
      }
      return realRm(target, options);
    });
    try {
      const releasing = first.release();
      await waitForFile(pausedPath);
      utimesSync(lockPath, new Date(0), new Date(0));
      let replacementAcquired = false;
      const replacementPending = acquireNpmInstallLock("release-race-provider", cacheDir).then((lock) => {
        replacementAcquired = true;
        return lock;
      });

      await Bun.sleep(100);
      expect(replacementAcquired).toBe(false);
      writeFileSync(resumePath, "resume");
      await releasing;
      const replacement = await replacementPending;
      expect(existsSync(lockPath)).toBe(true);

      await replacement.release();
    } finally {
      writeFileSync(resumePath, "resume");
      rm.mockRestore();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
