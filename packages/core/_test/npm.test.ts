import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const homes: string[] = [];

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

describe.serial("npmAdd", () => {
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
  }, 20_000);
});

describe.serial("isolated npm cache lifecycle", () => {
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
