import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { resolveProviderSource } from "../scripts/provider-source-cache";

const PACKAGE_NAME = "@fixture/provider";
const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const source = { packageName: PACKAGE_NAME, factoryName: "createFixture" };

type FailureScenario =
  | "missing latest dist-tag"
  | "metadata HTTP failure"
  | "tarball HTTP failure"
  | "tarball larger than 32 MiB"
  | "integrity mismatch"
  | "archive traversal path"
  | "archive symbolic link"
  | "package name mismatch"
  | "package version mismatch";

type RegistryFixtureOptions = {
  readonly latest: string;
  readonly scenario?: FailureScenario;
};

type RegistryFixture = {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: string[];
  readonly close: () => void;
  readonly setLatest: (version: string) => Promise<void>;
};

const cacheRoots: string[] = [];
const fixtures: RegistryFixture[] = [];

const fileExists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const integrity = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

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

  const archivePath = join(root, `${version}-${crypto.randomUUID()}.tgz`);
  await tar.create(
    {
      cwd: archiveRoot,
      file: archivePath,
      gzip: true,
      ...(scenario === "archive traversal path" ? { prefix: "../" } : {}),
    },
    ["package"],
  );
  return new Uint8Array(await Bun.file(archivePath).arrayBuffer());
}

async function createRegistryFixture(options: RegistryFixtureOptions): Promise<RegistryFixture> {
  const root = mkdtempSync(join(tmpdir(), "provider-source-registry-"));
  const requests: string[] = [];
  const tarballs = new Map<string, Uint8Array>();
  let latest = options.latest;

  const setLatest = async (version: string) => {
    latest = version;
    if (!tarballs.has(version)) tarballs.set(version, await createTarball(root, version, options.scenario));
  };
  await setLatest(latest);

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
                    : integrity(bytes),
              },
            },
          ]),
        );
        return Response.json({
          name: PACKAGE_NAME,
          "dist-tags": options.scenario === "missing latest dist-tag" ? {} : { latest },
          versions,
        });
      }

      const version = url.pathname.match(/^\/tarballs\/(.+)\.tgz$/)?.[1];
      if (version) {
        requests.push("tarball");
        if (options.scenario === "tarball HTTP failure") return new Response("tarball failed", { status: 502 });
        if (options.scenario === "tarball larger than 32 MiB") {
          return new Response(new Uint8Array(MAX_TARBALL_BYTES + 1));
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
      url.host = `127.0.0.1:${server.port}`;
      url.protocol = "http:";
      return globalThis.fetch(url, init);
    },
    requests,
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
    setLatest,
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
    await fixture.setLatest("3.0.0");

    const root = await resolveProviderSource(source, { cacheRoot, refreshLatest: true, fetch: fixture.fetch });

    expect(root).toEndWith("3.0.0/package");
    expect(fixture.requests).toEqual(["metadata", "tarball", "metadata", "tarball"]);
  });

  test.each<FailureScenario>([
    "missing latest dist-tag",
    "metadata HTTP failure",
    "tarball HTTP failure",
    "tarball larger than 32 MiB",
    "integrity mismatch",
    "archive traversal path",
    "archive symbolic link",
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
