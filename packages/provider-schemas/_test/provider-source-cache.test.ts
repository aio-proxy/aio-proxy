import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  | "integrity mismatch"
  | "malformed integrity"
  | "unsupported integrity algorithm"
  | "archive traversal path"
  | "archive absolute path"
  | "archive symbolic link"
  | "archive hard link"
  | "package name mismatch"
  | "package version mismatch";

type RegistryFixtureOptions = {
  readonly latest: string;
  readonly revision?: string;
  readonly scenario?: FailureScenario;
};

type TarballHold = {
  readonly waitForRequests: (count: number) => Promise<void>;
  readonly release: () => void;
};

type RegistryFixture = {
  readonly fetch: typeof globalThis.fetch;
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

async function createTarball(root: string, version: string, scenario?: FailureScenario): Promise<Uint8Array> {
  const archiveRoot = join(root, `archive-${version}-${crypto.randomUUID()}`);
  const packageRoot = join(archiveRoot, "package");
  await mkdir(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: scenario === "package name mismatch" ? "@fixture/wrong" : PACKAGE_NAME,
      version: scenario === "package version mismatch" ? "0.0.0" : version,
    }),
  );
  writeFileSync(join(packageRoot, "dist/index.d.ts"), "export declare function createFixture(): void;\n");
  writeFileSync(join(packageRoot, "dist/index.js"), "export function createFixture() {}\n");
  if (scenario === "archive symbolic link") {
    symlinkSync("index.d.ts", join(packageRoot, "dist/link.d.ts"));
  }
  if (scenario === "archive hard link") {
    writeFileSync(join(packageRoot, "dist/hard.d.ts"), "export declare function createFixture(): void;\n");
  }

  const archivePath = join(root, `${version}-${crypto.randomUUID()}.tgz`);
  await tar.create(
    {
      cwd: archiveRoot,
      file: archivePath,
      gzip: scenario !== "archive hard link",
      ...(scenario === "archive traversal path"
        ? { prefix: "../", preservePaths: true }
        : scenario === "archive absolute path"
          ? { prefix: "/", preservePaths: true }
          : {}),
    },
    ["package"],
  );
  const bytes = new Uint8Array(await Bun.file(archivePath).arrayBuffer());
  return scenario === "archive hard link" ? asHardLinkArchive(bytes) : bytes;
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
  let latest = options.latest;
  let revision = options.revision ?? "2026-07-11T00:00:00.000Z";

  const setLatest = async (version: string, nextRevision = revision) => {
    if (!tarballs.has(version)) tarballs.set(version, await createTarball(root, version, options.scenario));
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
      if (url.pathname === `/${encodeURIComponent(PACKAGE_NAME)}`) {
        requests.push("metadata");
        if (options.scenario === "metadata HTTP failure") return new Response("registry failed", { status: 503 });

        const versions = Object.fromEntries(
          [...tarballs].map(([version, bytes]) => [
            version,
            {
              name: PACKAGE_NAME,
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

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
  for (const root of cacheRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveProviderSource", () => {
  test("downloads npm latest and caches only declarations", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0" });
    const root = await resolveProviderSource(source, {
      cacheRoot: createCacheRoot(),
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
    expect(JSON.parse(await readFile(join(root, "../../latest.json"), "utf8"))).toEqual({
      version: "2.0.0",
      revision: "2026-07-11T00:00:00.000Z",
    });
  });

  test("watch mode reuses the cached latest pointer without registry access", async () => {
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

  test("rejects an unsafe cached latest pointer without registry access", async () => {
    const cacheRoot = createCacheRoot();
    const packageCache = join(cacheRoot, encodeURIComponent(PACKAGE_NAME));
    await mkdir(packageCache, { recursive: true });
    writeFileSync(
      join(packageCache, "latest.json"),
      JSON.stringify({ version: "../escape", revision: "2026-07-11T00:00:00.000Z" }),
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

  test("a stale concurrent refresh cannot regress the latest pointer", async () => {
    const fixture = await createRegistryFixture({
      latest: "1.0.0",
      revision: "2026-07-11T00:00:01.000Z",
    });
    const cacheRoot = createCacheRoot();
    const olderTarball = fixture.holdTarball("1.0.0");
    const older = resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    await olderTarball.waitForRequests(1);
    await fixture.setLatest("2.0.0", "2026-07-11T00:00:02.000Z");

    const newerRoot = await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });
    olderTarball.release();
    await older;
    const watchedRoot = await resolveProviderSource(source, {
      cacheRoot,
      refreshLatest: false,
      fetch: () => Promise.reject(new Error("registry must not be called")),
    });

    expect(newerRoot).toEndWith("2.0.0/package");
    expect(watchedRoot).toEndWith("2.0.0/package");
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
    const packageCache = join(cacheRoot, encodeURIComponent(PACKAGE_NAME));
    expect(new Set(roots).size).toBe(1);
    expect((await readdir(packageCache)).sort()).toEqual(["2.0.0", "latest.json"]);
  });

  test("cleans temporary cache entries after extraction validation fails", async () => {
    const fixture = await createRegistryFixture({ latest: "2.0.0", scenario: "package name mismatch" });
    const cacheRoot = createCacheRoot();
    await expect(
      resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch }),
    ).rejects.toThrow(PACKAGE_NAME);

    const packageCache = join(cacheRoot, encodeURIComponent(PACKAGE_NAME));
    expect(await readdir(packageCache)).toEqual([]);
  });

  test.each<FailureScenario>([
    "missing latest dist-tag",
    "metadata HTTP failure",
    "invalid metadata revision",
    "tarball HTTP failure",
    "tarball larger than 32 MiB",
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
