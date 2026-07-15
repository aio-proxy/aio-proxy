import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NpmLockError } from "../src";
import {
  findInstalledNpmPackage,
  listInstalledNpmPackages,
  NpmInstallError,
  npmAdd,
  npmPackageCacheDir,
  packagesDir,
  removeNpmPackageCache,
  withInstalledNpmPackage,
} from "../src/index";
import { acquireNpmInstallLock } from "../src/npm-lock";

const homes: string[] = [];

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

function sandboxHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-npm-home-"));
  homes.push(home);
  process.env.HOME = home;
  process.env.AIO_PROXY_HOME = home;
  return home;
}

function writeCachedPackage(pkg: string, version: string): string {
  const packageDir = join(npmPackageCacheDir(pkg), "node_modules", ...pkg.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: pkg, version, main: "index.js" }));
  const entrypoint = join(packageDir, "index.js");
  writeFileSync(entrypoint, "export function createFakeProvider() { return {}; }\n");
  return entrypoint;
}

type RegistryFixture = {
  readonly pkg: string;
  readonly registry: string;
  readonly stop: () => void;
  readonly metadataRequests: () => number;
};

async function fakeRegistry(pkg: string): Promise<RegistryFixture> {
  const dir = mkdtempSync(join(tmpdir(), "aio-proxy-registry-"));
  const packageRoot = join(dir, "package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0", main: "index.js" }));
  writeFileSync(
    join(packageRoot, "index.js"),
    "export function createFakeProvider() { return { languageModel() {} }; }\n",
  );

  const tarball = join(dir, `${pkg}.tgz`);
  const packed = Bun.spawnSync(["tar", "-czf", tarball, "package"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(packed.exitCode).toBe(0);

  let metadataRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === `/${pkg}`) {
        metadataRequests += 1;
        return Response.json({
          name: pkg,
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name: pkg,
              version: "1.0.0",
              dist: {
                tarball: `http://127.0.0.1:${server.port}/${pkg}.tgz`,
              },
            },
          },
        });
      }
      if (url.pathname === `/${pkg}.tgz`) {
        return new Response(Bun.file(tarball));
      }
      return new Response("missing", { status: 404 });
    },
  });

  return {
    pkg,
    registry: `http://127.0.0.1:${server.port}`,
    stop() {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
    metadataRequests: () => metadataRequests,
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
  delete process.env.HOME;
  delete process.env.AIO_PROXY_HOME;
});

describe("npmAdd", () => {
  test("Given cached package When added Then entrypoint and version return without spawning", async () => {
    // Given
    sandboxHome();
    const entrypoint = writeCachedPackage("@scope/fake-provider", "3.2.1");

    // When
    const installed = await npmAdd("@scope/fake-provider");

    // Then
    expect(installed).toEqual({ entrypoint, version: "3.2.1" });
  });

  test("Given missing package When install exits non-zero Then typed install error is returned", async () => {
    // Given
    sandboxHome();

    // When
    const result = npmAdd("aio-proxy-missing-package", "http://127.0.0.1:9");

    // Then
    await expect(result).rejects.toBeInstanceOf(NpmInstallError);
  });

  test("Given stale dead-pid lock When installing Then lock is recovered", async () => {
    // Given
    sandboxHome();
    const registry = await fakeRegistry(`aio-proxy-stale-lock-provider-${crypto.randomUUID()}`);
    const cacheDir = npmPackageCacheDir(registry.pkg);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, ".aio-proxy-install.lock"),
      JSON.stringify({
        pid: 999_999,
        createdAt: Date.now(),
        starttime: "dead-process",
        version: 1,
      }),
      { flag: "wx" },
    );

    try {
      // When
      const installed = await npmAdd(registry.pkg, registry.registry);

      // Then
      expect(existsSync(installed.entrypoint)).toBe(true);
      expect(installed.version).toBe("1.0.0");
    } finally {
      registry.stop();
    }
  });

  test("Given five concurrent installs When cache is empty Then one Bun add runs and waiters use cache", async () => {
    // Given
    sandboxHome();
    const registry = await fakeRegistry(`aio-proxy-concurrent-provider-${crypto.randomUUID()}`);

    try {
      // When
      const installed = await Promise.all(Array.from({ length: 5 }, () => npmAdd(registry.pkg, registry.registry)));

      // Then
      expect(new Set(installed.map((item) => item.entrypoint)).size).toBe(1);
      expect(registry.metadataRequests()).toBe(1);
      expect(existsSync(join(npmPackageCacheDir(registry.pkg), "node_modules", registry.pkg, "package.json"))).toBe(
        true,
      );
    } finally {
      registry.stop();
    }
  });

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

  test("Given unavailable identity and a live PID When heartbeat is stale Then the lock is not stolen", async () => {
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

    let acquired = false;
    const pending = acquireNpmInstallLock("reused-pid-provider", cacheDir).then((lock) => {
      acquired = true;
      return lock;
    });
    await Bun.sleep(100);
    expect(acquired).toBe(false);
    rmSync(lockPath);
    const lock = await pending;
    await lock.release();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("Given verifiable identity and a stale heartbeat When contending Then the old owner is fenced", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-stale-live-lock-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    const first = await acquireNpmInstallLock("stale-live-provider", cacheDir);
    utimesSync(lockPath, new Date(0), new Date(0));

    const replacement = await acquireNpmInstallLock("stale-live-provider", cacheDir);
    await expect(first.withOwnership(async () => "stale")).rejects.toThrow("Npm lock ownership lost");
    expect(existsSync(lockPath)).toBe(true);

    await first.release();
    await replacement.release();
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

  test("Given a dead recovery-fence owner When acquiring Then the marker is reclaimed", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-stale-marker-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    const markerPath = `${lockPath}.recovery.stale-owner`;
    writeFileSync(
      markerPath,
      JSON.stringify({ pid: 999_999, createdAt: 0, owner: "stale-owner", starttime: "dead", version: 1 }),
    );
    utimesSync(markerPath, new Date(0), new Date(0));

    const lock = await acquireNpmInstallLock("stale-marker-provider", cacheDir);
    expect(existsSync(markerPath)).toBe(false);
    await lock.release();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("Given an aged malformed recovery marker When acquiring Then the marker is reclaimed", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-malformed-marker-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    const markerPath = `${lockPath}.recovery.partial-owner`;
    writeFileSync(markerPath, "");
    utimesSync(markerPath, new Date(0), new Date(0));

    const lock = await acquireNpmInstallLock("malformed-marker-provider", cacheDir, { waitMs: 500 });

    expect(existsSync(markerPath)).toBe(false);
    await lock.release();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("Given a hung process identity lookup When locking Then the child is killed within the wait budget", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-hung-identity-"));
    const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
    const originalSpawn = mutableBun.spawn;
    let killed = 0;
    mutableBun.spawn = (() => {
      let closed = false;
      let resolveExit!: (code: number) => void;
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          setTimeout(() => {
            if (closed) return;
            closed = true;
            controller.enqueue(new TextEncoder().encode("MATCH\n"));
            controller.close();
            resolveExit(0);
          }, 400);
        },
      });
      return {
        stdout,
        exited,
        kill() {
          killed += 1;
          if (closed) return;
          closed = true;
          controller.close();
          resolveExit(1);
        },
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    let lock: Awaited<ReturnType<typeof acquireNpmInstallLock>> | undefined;
    try {
      lock = await acquireNpmInstallLock("hung-identity-provider", cacheDir, { waitMs: 2_000 });
      expect(killed).toBeGreaterThan(0);
    } finally {
      mutableBun.spawn = originalSpawn;
      await lock?.release();
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("Given a live recovery-fence owner When heartbeat is old Then the marker is not stolen", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-live-marker-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    const markerPath = `${lockPath}.recovery.live-owner`;
    const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], { stdout: "pipe" });
    const starttime = new TextDecoder().decode(ps.stdout).trim();
    writeFileSync(
      markerPath,
      JSON.stringify({ pid: process.pid, createdAt: 0, owner: "live-owner", starttime, version: 1 }),
    );
    utimesSync(markerPath, new Date(0), new Date(0));

    let acquired = false;
    const pending = acquireNpmInstallLock("live-marker-provider", cacheDir).then((lock) => {
      acquired = true;
      return lock;
    });
    await Bun.sleep(100);
    expect(acquired).toBe(false);
    expect(existsSync(markerPath)).toBe(true);
    rmSync(markerPath);
    const lock = await pending;
    await lock.release();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  test("Given a live recovery marker with unavailable identity When waiting Then acquisition fails within its budget", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "aio-proxy-unverifiable-marker-"));
    const lockPath = join(cacheDir, ".aio-proxy-install.lock");
    const markerPath = `${lockPath}.recovery.unknown-owner`;
    writeFileSync(
      markerPath,
      JSON.stringify({
        pid: process.pid,
        createdAt: 0,
        owner: "unknown-owner",
        starttime: "unavailable",
        version: 1,
      }),
    );

    const pending = acquireNpmInstallLock("unknown-marker-provider", cacheDir, { waitMs: 100 });
    try {
      await expect(
        Promise.race([
          pending,
          Bun.sleep(500).then(() => {
            throw new Error("npm recovery-fence wait was unbounded");
          }),
        ]),
      ).rejects.toBeInstanceOf(NpmLockError);
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      rmSync(markerPath, { force: true });
      const lock = await pending.catch(() => null);
      await lock?.release();
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
        const lock = await acquireNpmInstallLock("stale-lock-race-provider", cacheDir);
        active += 1;
        maximum = Math.max(maximum, active);
        await Bun.sleep(10);
        active -= 1;
        await lock.release();
      }),
    );
    expect(maximum).toBe(1);
    rmSync(cacheDir, { recursive: true, force: true });
  });

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

describe("isolated npm cache lifecycle", () => {
  test("lists only the requested cache root package, never its dependencies", async () => {
    sandboxHome();
    writeCachedPackage("root-plugin", "1.0.0");
    writeCachedPackage("dependency-package", "9.0.0");
    const dependencyDir = join(npmPackageCacheDir("root-plugin"), "node_modules", "dependency-package");
    mkdirSync(dependencyDir, { recursive: true });
    writeFileSync(
      join(dependencyDir, "package.json"),
      JSON.stringify({ name: "dependency-package", version: "9.0.0" }),
    );

    expect((await listInstalledNpmPackages()).map((pkg) => pkg.packageName)).toEqual([
      "dependency-package",
      "root-plugin",
    ]);
  });

  test("cache removal is idempotent", async () => {
    sandboxHome();
    writeCachedPackage("removable-plugin", "1.0.0");
    expect(await removeNpmPackageCache("removable-plugin")).toBe(true);
    expect(await removeNpmPackageCache("removable-plugin")).toBe(false);
  });

  test("an installed package stays locked through its caller's config commit", async () => {
    sandboxHome();
    writeCachedPackage("racing-plugin", "1.0.0");
    let allowCommit!: () => void;
    const commit = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    let callbackEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      callbackEntered = resolve;
    });
    let removalGuardCalled = false;

    const add = withInstalledNpmPackage("racing-plugin", undefined, async () => {
      callbackEntered();
      await commit;
    });
    await entered;
    const lifecycleLock = join(packagesDir(), ".locks", encodeURIComponent("racing-plugin"), ".aio-proxy-install.lock");
    expect(existsSync(lifecycleLock)).toBe(true);
    expect(lifecycleLock.startsWith(npmPackageCacheDir("racing-plugin"))).toBe(false);
    const remove = removeNpmPackageCache("racing-plugin", async () => {
      removalGuardCalled = true;
      return false;
    });
    await Bun.sleep(20);
    expect(removalGuardCalled).toBe(false);

    allowCommit();
    await add;
    expect(await remove).toBe(false);
    expect(removalGuardCalled).toBe(true);
    expect(await findInstalledNpmPackage("racing-plugin")).not.toBeNull();
  });
});
