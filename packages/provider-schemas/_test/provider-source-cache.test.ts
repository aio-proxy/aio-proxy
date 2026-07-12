import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as tar from "tar";
import { resolveProviderSource } from "../scripts/provider-source-cache";

const PACKAGE_NAME = "@fixture/provider";
const source = { packageName: PACKAGE_NAME, factoryName: "createFixture" };

type FailureScenario =
  | "missing latest dist-tag"
  | "metadata HTTP failure"
  | "invalid metadata revision"
  | "tarball HTTP failure"
  | "tarball larger than 32 MiB"
  | "extracted declarations larger than limit"
  | "more than 65 extracted files"
  | "integrity mismatch"
  | "malformed integrity"
  | "unsupported integrity algorithm"
  | "archive traversal path"
  | "archive absolute path"
  | "archive symbolic link"
  | "archive hard link"
  | "declaration-shaped directory"
  | "package name mismatch"
  | "package version mismatch";

type RegistryFixtureOptions = {
  readonly latest: string;
  readonly revision?: string;
  readonly scenario?: FailureScenario;
  readonly packageName?: string;
};

type TarballHold = {
  readonly waitForRequests: (count: number) => Promise<void>;
  readonly release: () => void;
};

type RegistryFixture = {
  readonly fetch: typeof globalThis.fetch;
  readonly registryOrigin: string;
  readonly requests: string[];
  readonly close: () => void;
  readonly setLatest: (version: string, revision?: string) => Promise<void>;
  readonly holdTarball: (version: string) => TarballHold;
  readonly streamState: { canceled: boolean; chunks: number };
};

const cacheRoots: string[] = [];
const fixtures: RegistryFixture[] = [];

const fileExists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const integrity = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const packageCachePath = (cacheRoot: string, packageName = PACKAGE_NAME) =>
  join(cacheRoot, `package-${createHash("sha256").update(packageName).digest("hex")}`);

const asHardLinkArchive = (archive: Uint8Array): Uint8Array => {
  const bytes = Buffer.from(archive);
  for (let offset = 0; offset < bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    const dataBytes = Math.ceil(size / 512) * 512;
    if (path === "package/dist/hard.d.ts") {
      const replacement = Buffer.from(header);
      replacement[156] = "1".charCodeAt(0);
      replacement.fill(0, 157, 257);
      replacement.write("package/dist/index.d.ts", 157, "utf8");
      replacement.fill(0, 124, 136);
      replacement.write("00000000000\0", 124, "ascii");
      replacement.fill(0x20, 148, 156);
      const checksum = [...replacement]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0");
      replacement.write(`${checksum}\0 `, 148, "ascii");
      return Buffer.concat([bytes.subarray(0, offset), replacement, bytes.subarray(offset + 512 + dataBytes)]);
    }
    offset += 512 + dataBytes;
  }
  throw new Error("hard-link fixture entry missing");
};

const withCorruptTrailingEntry = (
  archive: Uint8Array,
  trailingPath = "package/dist/z-after-limit.d.ts",
): Uint8Array => {
  const bytes = Buffer.from(archive);
  for (let offset = 0; offset < bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    if (path === trailingPath) {
      bytes[offset] ^= 1;
      return bytes;
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("trailing fixture entry missing");
};

const withDirectoryPathWithoutTrailingSlash = (archive: Uint8Array): Uint8Array => {
  const bytes = Buffer.from(archive);
  for (let offset = 0; offset < bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    const path = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    if (path === "package/dist/empty.d.ts/") {
      const replacement = Buffer.from(header);
      replacement.fill(0, 0, 100);
      replacement.write("package/dist/empty.d.ts", 0, "utf8");
      replacement.fill(0x20, 148, 156);
      const checksum = [...replacement]
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, "0");
      replacement.write(`${checksum}\0 `, 148, "ascii");
      return Buffer.concat([bytes.subarray(0, offset), replacement, bytes.subarray(offset + 512)]);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("declaration-shaped directory fixture entry missing");
};

async function createTarball(
  root: string,
  version: string,
  scenario?: FailureScenario,
  packageName = PACKAGE_NAME,
): Promise<Uint8Array> {
  const archiveRoot = join(root, `archive-${version}-${crypto.randomUUID()}`);
  const packageRoot = join(archiveRoot, "package");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: scenario === "package name mismatch" ? "@fixture/wrong" : packageName,
      version: scenario === "package version mismatch" ? "0.0.0" : version,
    }),
  );
  writeFileSync(join(packageRoot, "dist/index.d.ts"), "export declare function createFixture(): void;\n");
  if (scenario === "extracted declarations larger than limit") {
    writeFileSync(join(packageRoot, "dist/index.d.ts"), `export type Huge = "${"x".repeat(5 * 1024 * 1024)}";\n`);
    symlinkSync("index.d.ts", join(packageRoot, "dist/z-after-limit.d.ts"));
  }
  if (scenario === "more than 65 extracted files") {
    for (let index = 0; index < 64; index += 1) {
      writeFileSync(join(packageRoot, `dist/entry-${index.toString().padStart(2, "0")}.d.ts`), "");
    }
    writeFileSync(join(packageRoot, "dist/zz-corrupt-trailing.d.ts"), "");
  }
  writeFileSync(join(packageRoot, "dist/index.js"), "export function createFixture() {}\n");
  if (scenario === "archive symbolic link") {
    symlinkSync("index.d.ts", join(packageRoot, "dist/link.d.ts"));
  }
  if (scenario === "archive hard link") {
    writeFileSync(join(packageRoot, "dist/hard.d.ts"), "export declare function createFixture(): void;\n");
  }
  if (scenario === "declaration-shaped directory") {
    await mkdir(join(packageRoot, "dist/empty.d.ts"));
  }

  const archivePath = join(root, `${version}-${crypto.randomUUID()}.tgz`);
  await tar.create(
    {
      cwd: archiveRoot,
      file: archivePath,
      gzip:
        scenario !== "archive hard link" &&
        scenario !== "extracted declarations larger than limit" &&
        scenario !== "more than 65 extracted files" &&
        scenario !== "declaration-shaped directory",
      noDirRecurse:
        scenario === "extracted declarations larger than limit" || scenario === "more than 65 extracted files",
      ...(scenario === "archive traversal path"
        ? { prefix: "../", preservePaths: true }
        : scenario === "archive absolute path"
          ? { prefix: "/", preservePaths: true }
          : {}),
    },
    scenario === "extracted declarations larger than limit"
      ? [
          "package",
          "package/package.json",
          "package/dist",
          "package/dist/index.d.ts",
          "package/dist/z-after-limit.d.ts",
          "package/dist/index.js",
        ]
      : scenario === "more than 65 extracted files"
        ? [
            "package",
            "package/package.json",
            "package/dist",
            "package/dist/index.d.ts",
            ...Array.from({ length: 64 }, (_, index) => `package/dist/entry-${index.toString().padStart(2, "0")}.d.ts`),
            "package/dist/zz-corrupt-trailing.d.ts",
            "package/dist/index.js",
          ]
        : ["package"],
  );
  const bytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
  if (scenario === "archive hard link") return asHardLinkArchive(bytes);
  if (scenario === "extracted declarations larger than limit") return withCorruptTrailingEntry(bytes);
  if (scenario === "more than 65 extracted files") {
    return withCorruptTrailingEntry(bytes, "package/dist/zz-corrupt-trailing.d.ts");
  }
  if (scenario === "declaration-shaped directory") return withDirectoryPathWithoutTrailingSlash(bytes);
  return bytes;
}

async function createRegistryFixture(options: RegistryFixtureOptions): Promise<RegistryFixture> {
  const root = mkdtempSync(join(tmpdir(), "provider-source-registry-"));
  const requests: string[] = [];
  const tarballs = new Map<string, Uint8Array>();
  const heldTarballs = new Map<
    string,
    {
      requests: number;
      readonly waiters: Array<{ count: number; resolve: () => void }>;
      release: () => void;
      gate: Promise<void>;
    }
  >();
  const streamState = { canceled: false, chunks: 0 };
  const packageName = options.packageName ?? PACKAGE_NAME;
  let latest = options.latest;
  let revision = options.revision ?? "2026-07-11T00:00:00.000Z";

  const setLatest = async (version: string, nextRevision = revision) => {
    if (!tarballs.has(version)) {
      tarballs.set(version, await createTarball(root, version, options.scenario, packageName));
    }
    latest = version;
    revision = nextRevision;
  };
  await setLatest(latest);

  const oversizedResponse = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          streamState.chunks += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
          if (streamState.chunks >= 100) controller.close();
        },
        cancel() {
          streamState.canceled = true;
        },
      }),
    );

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === `/${encodeURIComponent(packageName)}`) {
        requests.push("metadata");
        if (options.scenario === "metadata HTTP failure") return new Response("registry failed", { status: 503 });

        const versions = Object.fromEntries(
          [...tarballs].map(([version, bytes]) => [
            version,
            {
              name: packageName,
              version,
              dist: {
                tarball: `http://127.0.0.1:${server.port}/tarballs/${version}.tgz`,
                integrity:
                  options.scenario === "integrity mismatch"
                    ? `sha512-${Buffer.alloc(64).toString("base64")}`
                    : options.scenario === "malformed integrity"
                      ? "not-sri"
                      : options.scenario === "unsupported integrity algorithm"
                        ? `nope-${Buffer.alloc(64).toString("base64")}`
                        : integrity(bytes),
              },
            },
          ]),
        );
        return Response.json({
          name: PACKAGE_NAME,
          "dist-tags": options.scenario === "missing latest dist-tag" ? {} : { latest },
          versions,
          time: { modified: options.scenario === "invalid metadata revision" ? "July 11, 2026" : revision },
        });
      }

      const version = url.pathname.match(/^\/tarballs\/(.+)\.tgz$/)?.[1];
      if (version) {
        requests.push("tarball");
        const held = heldTarballs.get(version);
        if (held) {
          held.requests += 1;
          for (const waiter of held.waiters.splice(0)) {
            if (held.requests >= waiter.count) waiter.resolve();
            else held.waiters.push(waiter);
          }
          await held.gate;
        }
        if (options.scenario === "tarball HTTP failure") return new Response("tarball failed", { status: 502 });
        if (options.scenario === "tarball larger than 32 MiB") {
          return oversizedResponse();
        }
        const bytes = tarballs.get(version);
        return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
      }
      return new Response("missing", { status: 404 });
    },
  });

  const fixture: RegistryFixture = {
    fetch: (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (options.scenario === "tarball larger than 32 MiB" && url.pathname.startsWith("/tarballs/")) {
        requests.push("tarball");
        return Promise.resolve(oversizedResponse());
      }
      url.host = `127.0.0.1:${server.port}`;
      url.protocol = "http:";
      return globalThis.fetch(url, init);
    },
    requests,
    registryOrigin: `http://127.0.0.1:${server.port}`,
    close() {
      for (const held of heldTarballs.values()) held.release();
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
    setLatest,
    holdTarball(version) {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = { requests: 0, waiters: [], release, gate };
      heldTarballs.set(version, held);
      return {
        waitForRequests(count) {
          if (held.requests >= count) return Promise.resolve();
          return new Promise((resolve) => held.waiters.push({ count, resolve }));
        },
        release,
      };
    },
    streamState,
  };
  fixtures.push(fixture);
  return fixture;
}

const createCacheRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "provider-source-cache-"));
  cacheRoots.push(root);
  return root;
};

const observationFileName = (revision: string) => `${createHash("sha256").update(revision).digest("hex")}.json`;
const completionPath = (cacheRoot: string, version: string) =>
  join(packageCachePath(cacheRoot), version, "completion.json");
const packageRootPath = (cacheRoot: string, version: string) => join(packageCachePath(cacheRoot), version, "package");

const spawnResolver = (cacheRoot: string, registryOrigin: string) => {
  const modulePath = join(process.cwd(), "packages/provider-schemas/scripts/provider-source-cache.ts");
  const code = `
    import { resolveProviderSource } from ${JSON.stringify(modulePath)};
    const nativeFetch = globalThis.fetch;
    const registryOrigin = process.env.REGISTRY_ORIGIN;
    const fixtureFetch = (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname === "registry.npmjs.org") {
        const origin = new URL(registryOrigin);
        url.protocol = origin.protocol;
        url.host = origin.host;
      }
      return nativeFetch(url, init);
    };
    await resolveProviderSource(
      { packageName: ${JSON.stringify(PACKAGE_NAME)}, factoryName: "createFixture" },
      { cacheRoot: process.env.CACHE_ROOT, refreshLatest: true, fetch: fixtureFetch },
    );
  `;
  return Bun.spawn({
    cmd: [process.execPath, "-e", code],
    cwd: process.cwd(),
    env: { ...process.env, CACHE_ROOT: cacheRoot, REGISTRY_ORIGIN: registryOrigin },
    stdout: "ignore",
    stderr: "pipe",
  });
};

const expectWorkerSuccess = async (worker: ReturnType<typeof spawnResolver>) => {
  const stderr = worker.stderr instanceof ReadableStream ? new Response(worker.stderr).text() : Promise.resolve("");
  const [exitCode, errorOutput] = await Promise.all([worker.exited, stderr]);
  expect(errorOutput).toBe("");
  expect(exitCode).toBe(0);
};

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const root of cacheRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveProviderSource", () => {
  test("downloads npm latest and caches only declarations", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();
    const root = await resolveProviderSource(source, {
      cacheRoot,
      refreshLatest: true,
      fetch: fixture.fetch,
    });

    expect(JSON.parse(await readFile(join(root, "package.json"), "utf8"))).toMatchObject({
      name: PACKAGE_NAME,
      version: "2.0.0",
    });
    expect(await readFile(join(root, "dist/index.d.ts"), "utf8")).toContain("createFixture");
    expect(await fileExists(join(root, "dist/index.js"))).toBe(false);
    expect(fixture.requests).toEqual(["metadata", "tarball"]);
    const completion = JSON.parse(await readFile(completionPath(cacheRoot, "2.0.0"), "utf8"));
    expect(completion).toMatchObject({
      packageName: PACKAGE_NAME,
      version: "2.0.0",
      integrity: expect.stringMatching(/^sha512-/),
    });
    expect(completion.files).toEqual([
      {
        path: "dist/index.d.ts",
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      {
        path: "package.json",
        size: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    const observationRoot = join(root, "../../observations");
    const observations = await readdir(observationRoot);
    expect(observations).toHaveLength(1);
    expect(JSON.parse(await readFile(join(observationRoot, observations[0] as string), "utf8"))).toEqual({
      version: "2.0.0",
      revision: "2026-07-11T00:00:00.000Z",
      integrity: completion.integrity,
    });
  });

  test.each([
    ["missing declaration", (path: string) => rmSync(path)],
    ["modified declaration", (path: string) => writeFileSync(path, "export type Corrupt = true;\n")],
  ] as const)("rejects a cache hit with a %s without mutating the shared version", async (_scenario, corrupt) => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    const declaration = join(packageRootPath(cacheRoot, "2.0.0"), "dist/index.d.ts");
    corrupt(declaration);

    await expect(
      resolveProviderSource(source, {
        cacheRoot,
        refreshLatest: false,
        fetch: () => Promise.reject(new Error("registry unavailable")),
      }),
    ).rejects.toThrow(PACKAGE_NAME);

    if (_scenario === "missing declaration") expect(await fileExists(declaration)).toBe(false);
    else expect(await readFile(declaration, "utf8")).toContain("Corrupt");
  });

  test("rejects a cache hit whose completion manifest identity is changed", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    const path = completionPath(cacheRoot, "2.0.0");
    const completion = JSON.parse(await readFile(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...completion, packageName: "@fixture/changed" }));

    await expect(
      resolveProviderSource(source, {
        cacheRoot,
        refreshLatest: false,
        fetch: () => Promise.reject(new Error("registry unavailable")),
      }),
    ).rejects.toThrow(PACKAGE_NAME);
    expect(JSON.parse(await readFile(path, "utf8")).packageName).toBe("@fixture/changed");
  });

  test("rejects unexpected declaration state not recorded by the completion manifest", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    const unexpected = join(packageRootPath(cacheRoot, "2.0.0"), "dist/unexpected.d.ts");
    writeFileSync(unexpected, "export type Unexpected = true;\n");

    await expect(
      resolveProviderSource(source, {
        cacheRoot,
        refreshLatest: false,
        fetch: () => Promise.reject(new Error("registry unavailable")),
      }),
    ).rejects.toThrow(PACKAGE_NAME);
    expect(await fileExists(unexpected)).toBe(true);
  });

  test("watch mode reuses the latest cached observation without registry access", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });

    const root = await resolveProviderSource(source, {
      cacheRoot,
      refreshLatest: false,
      fetch: () => Promise.reject(new Error("registry must not be called")),
    });

    expect(root).toEndWith("2.0.0/package");
  });

  test("cold watch resolves npm latest once then reuses the observation", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();

    const coldRoot = await resolveProviderSource(source, {
      cacheRoot,
      refreshLatest: false,
      fetch: fixture.fetch,
    });
    const warmRoot = await resolveProviderSource(source, {
      cacheRoot,
      refreshLatest: false,
      fetch: () => Promise.reject(new Error("registry must not be called")),
    });

    expect(coldRoot).toBe(warmRoot);
    expect(fixture.requests).toEqual(["metadata", "tarball"]);
  });

  test("canonicalizes the registry revision before publishing an observation", async () => {
    const fixture = await createRegistryFixture({
      latest: "2.0.0",
      revision: "2026-07-11T08:00:00+08:00",
    });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });

    const observationRoot = join(packageCachePath(cacheRoot), "observations");
    const observations = await readdir(observationRoot);
    expect(observations).toEqual([observationFileName("2026-07-11T00:00:00.000Z")]);
    expect(JSON.parse(await readFile(join(observationRoot, observations[0] as string), "utf8"))).toEqual({
      version: "2.0.0",
      revision: "2026-07-11T00:00:00.000Z",
      integrity: expect.stringMatching(/^sha512-/),
    });
  });

  test("refreshes metadata without redownloading an unchanged latest version", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });

    expect(fixture.requests).toEqual(["metadata", "tarball", "metadata"]);
  });

  test("downloads a new cache entry when npm latest changes", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    await fixture.setLatest("3.0.0", "2026-07-11T00:00:01.000Z");

    const root = await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });

    expect(root).toEndWith("3.0.0/package");
    expect(fixture.requests).toEqual(["metadata", "tarball", "metadata", "tarball"]);
  });

  test.each([
    "",
    ".",
    "..",
    "../escape",
    "nested/version",
    "nested\\version",
    "bad\0version",
  ])("rejects unsafe registry latest version %j", async (version) => {
    let tarballCalls = 0;
    const result = resolveProviderSource(source, {
      cacheRoot: createCacheRoot(),
      refreshLatest: true,
      fetch: (input) => {
        if (String(input).includes("tarball")) {
          tarballCalls += 1;
          return Promise.resolve(new Response("not reached"));
        }
        return Promise.resolve(
          Response.json({
            "dist-tags": { latest: version },
            versions: {
              [version]: {
                name: PACKAGE_NAME,
                version,
                dist: {
                  tarball: "https://fixture.invalid/tarball",
                  integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
                },
              },
            },
            time: { modified: "2026-07-11T00:00:00.000Z" },
          }),
        );
      },
    });

    await expect(result).rejects.toThrow(PACKAGE_NAME);
    expect(tarballCalls).toBe(0);
  });

  test("rejects an unsafe cached observation without registry access", async () => {
    const cacheRoot = createCacheRoot();
    const packageCache = packageCachePath(cacheRoot);
    const observationRoot = join(packageCache, "observations");
    const revision = "2026-07-11T00:00:00.000Z";
    await mkdir(observationRoot, { recursive: true });
    writeFileSync(
      join(observationRoot, observationFileName(revision)),
      JSON.stringify({ version: "../escape", revision }),
    );

    let registryCalls = 0;
    const result = resolveProviderSource(source, {
      cacheRoot,
      refreshLatest: false,
      fetch: () => {
        registryCalls += 1;
        return Promise.reject(new Error("registry must not be called"));
      },
    });

    await expect(result).rejects.toThrow(PACKAGE_NAME);
    expect(registryCalls).toBe(0);
  });

  test("returns an absolute package root for a relative cache root", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const relativeRoot = `.provider-source-cache-${crypto.randomUUID()}`;
    cacheRoots.push(join(process.cwd(), relativeRoot));

    const root = await resolveProviderSource(source, {
      cacheRoot: relativeRoot,
      refreshLatest: true,
      fetch: fixture.fetch,
    });

    expect(root).toStartWith(`${process.cwd()}/`);
  });

  test("cancels an unknown-length tarball stream at the size limit", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0", scenario: "tarball larger than 32 MiB" });

    await expect(
      resolveProviderSource(source, {
        cacheRoot: createCacheRoot(),
        refreshLatest: true,
        fetch: fixture.fetch,
      }),
    ).rejects.toThrow(PACKAGE_NAME);

    expect(fixture.streamState.canceled).toBe(true);
    expect(fixture.streamState.chunks).toBeLessThan(40);
  });

  test("aborts extraction at the size header before processing trailing entries", async () => {
    const fixture = await createRegistryFixture({
      latest: "2.0.0",
      scenario: "extracted declarations larger than limit",
    });

    await expect(
      resolveProviderSource(source, {
        cacheRoot: createCacheRoot(),
        refreshLatest: true,
        fetch: fixture.fetch,
      }),
    ).rejects.toThrow(`Extracted declaration size limit exceeded for ${PACKAGE_NAME}`);
  });

  test("aborts extraction after 65 allowed files before processing trailing entries", async () => {
    const fixture = await createRegistryFixture({
      latest: "2.0.0",
      scenario: "more than 65 extracted files",
    });
    const cacheRoot = createCacheRoot();

    await expect(
      resolveProviderSource(source, {
        cacheRoot,
        refreshLatest: true,
        fetch: fixture.fetch,
      }),
    ).rejects.toThrow(`Extracted file count limit exceeded for ${PACKAGE_NAME}`);
    expect((await readdir(packageCachePath(cacheRoot))).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("does not extract declaration-shaped archive directories", async () => {
    const fixture = await createRegistryFixture({
      latest: "2.0.0",
      scenario: "declaration-shaped directory",
    });

    const root = await resolveProviderSource(source, {
      cacheRoot: createCacheRoot(),
      refreshLatest: true,
      fetch: fixture.fetch,
    });

    expect(await fileExists(join(root, "dist/empty.d.ts"))).toBe(false);
  });

  test("slow old and fast new cross-process observations coexist and watch selects new", async () => {
    const fixture = await createRegistryFixture({
      latest: "1.0.0",
      revision: "2026-07-11T00:00:01.000Z",
    });
    const cacheRoot = createCacheRoot();
    const olderTarball = fixture.holdTarball("1.0.0");
    const older = spawnResolver(cacheRoot, fixture.registryOrigin);
    await olderTarball.waitForRequests(1);
    await fixture.setLatest("2.0.0", "2026-07-11T00:00:02.000Z");

    const newer = spawnResolver(cacheRoot, fixture.registryOrigin);
    await expectWorkerSuccess(newer);
    olderTarball.release();
    await expectWorkerSuccess(older);
    const watchedRoot = await resolveProviderSource(source, {
      cacheRoot,
      refreshLatest: false,
      fetch: () => Promise.reject(new Error("registry must not be called")),
    });

    expect(watchedRoot).toEndWith("2.0.0/package");
    const observations = await readdir(join(packageCachePath(cacheRoot), "observations"));
    expect(observations).toHaveLength(2);
  });

  test("a newer registry revision may intentionally roll latest back", async () => {
    const fixture = await createRegistryFixture({
      latest: "2.0.0",
      revision: "2026-07-11T00:00:02.000Z",
    });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    await fixture.setLatest("1.0.0", "2026-07-11T00:00:03.000Z");
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });

    const watchedRoot = await resolveProviderSource(source, {
      cacheRoot,
      refreshLatest: false,
      fetch: () => Promise.reject(new Error("registry must not be called")),
    });

    expect(watchedRoot).toEndWith("1.0.0/package");
  });

  test("rejects the same registry revision resolving to a different version", async () => {
    const revision = "2026-07-11T00:00:02.000Z";
    const fixture = await createRegistryFixture({ latest: "2.0.0", revision });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    await fixture.setLatest("1.0.0", revision);

    await expect(
      resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch }),
    ).rejects.toThrow(PACKAGE_NAME);
  });

  test("rejects the same registry revision and version with different integrity metadata", async () => {
    const revision = "2026-07-11T00:00:02.000Z";
    const fixture = await createRegistryFixture({ latest: "2.0.0", revision });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });

    const conflictingFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await fixture.fetch(input, init);
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.hostname !== "registry.npmjs.org") return response;
      const metadata = await response.json();
      metadata.versions["2.0.0"].dist.integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
      return Response.json(metadata);
    };

    await expect(
      resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: conflictingFetch }),
    ).rejects.toThrow("conflicting integrities");
    expect(fixture.requests).toEqual(["metadata", "tarball", "metadata"]);
  });

  test("watch falls back to an older valid observation when the newest cached source is corrupt", async () => {
    const fixture = await createRegistryFixture({
      latest: "1.0.0",
      revision: "2026-07-11T00:00:01.000Z",
    });
    const cacheRoot = createCacheRoot();
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    await fixture.setLatest("2.0.0", "2026-07-11T00:00:02.000Z");
    await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    const newestDeclaration = join(packageRootPath(cacheRoot, "2.0.0"), "dist/index.d.ts");
    writeFileSync(newestDeclaration, "export type Corrupt = true;\n");

    const root = await resolveProviderSource(source, {
      cacheRoot,
      refreshLatest: false,
      fetch: () => Promise.reject(new Error("registry must not be called")),
    });

    expect(root).toEndWith("1.0.0/package");
    expect(await readFile(newestDeclaration, "utf8")).toContain("Corrupt");
  });

  test("concurrent cache winner is validated and temporary directories are cleaned", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();
    const tarball = fixture.holdTarball("2.0.0");
    const resolutions = [
      resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch }),
      resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch }),
    ];
    await tarball.waitForRequests(2);
    tarball.release();

    const roots = await Promise.all(resolutions);
    const packageCache = packageCachePath(cacheRoot);
    expect(new Set(roots).size).toBe(1);
    expect((await readdir(packageCache)).sort()).toEqual(["2.0.0", "observations"]);
  });

  test("rejects a corrupt concurrent destination and cleans verified temporary paths", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const cacheRoot = createCacheRoot();
    const packageCache = packageCachePath(cacheRoot);
    const tarball = fixture.holdTarball("2.0.0");
    const resolutions = [
      resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch }),
      resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch }),
    ];
    await tarball.waitForRequests(2);
    await mkdir(join(packageCache, "2.0.0/package"), { recursive: true });
    writeFileSync(
      join(packageCache, "2.0.0/package/package.json"),
      JSON.stringify({ name: "@fixture/corrupt", version: "2.0.0" }),
    );
    tarball.release();

    const results = await Promise.allSettled(resolutions);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") expect(String(result.reason)).toContain("remove the provider schema cache");
    }
    expect(JSON.parse(await readFile(join(packageCache, "2.0.0/package/package.json"), "utf8"))).toMatchObject({
      name: "@fixture/corrupt",
      version: "2.0.0",
    });
    expect((await readdir(packageCache)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("cleans temporary cache entries after extraction validation fails", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0", scenario: "package name mismatch" });
    const cacheRoot = createCacheRoot();
    await expect(
      resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch }),
    ).rejects.toThrow(PACKAGE_NAME);

    const packageCache = packageCachePath(cacheRoot);
    expect(await readdir(packageCache)).toEqual([]);
  });

  test.each([".", ".."])('rejects unsafe package name "%s" before cache or registry use', async (packageName) => {
    const sandbox = mkdtempSync(join(tmpdir(), "provider-package-name-cache-"));
    cacheRoots.push(sandbox);
    const cacheRoot = join(sandbox, "cache");
    await mkdir(cacheRoot);
    let registryCalls = 0;

    await expect(
      resolveProviderSource(
        { packageName, factoryName: "createFixture" },
        {
          cacheRoot,
          refreshLatest: true,
          fetch: () => {
            registryCalls += 1;
            return Promise.reject(new Error("registry must not be called"));
          },
        },
      ),
    ).rejects.toThrow(packageName);

    expect(registryCalls).toBe(0);
    expect(await readdir(cacheRoot)).toEqual([]);
    expect(await readdir(sandbox)).toEqual([basename(cacheRoot)]);
  });

  test.each<FailureScenario>([
    "missing latest dist-tag",
    "metadata HTTP failure",
    "invalid metadata revision",
    "tarball HTTP failure",
    "tarball larger than 32 MiB",
    "extracted declarations larger than limit",
    "integrity mismatch",
    "malformed integrity",
    "unsupported integrity algorithm",
    "archive traversal path",
    "archive absolute path",
    "archive symbolic link",
    "archive hard link",
    "package name mismatch",
    "package version mismatch",
  ])("rejects %s", async (scenario) => {
    const fixture = await createRegistryFixture({ latest: "2.0.0", scenario });
    const result = resolveProviderSource(source, {
      cacheRoot: createCacheRoot(),
      refreshLatest: true,
      fetch: fixture.fetch,
    });

    await expect(result).rejects.toThrow(PACKAGE_NAME);
  });
});
