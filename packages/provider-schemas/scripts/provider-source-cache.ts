import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type * as Tar from "tar";
import { providerSchemasRequire } from "./provider-schemas-require";

const tar = providerSchemasRequire("tar") as typeof Tar;

export type ProviderSchemaSource = {
  readonly packageName: string;
  readonly factoryName: string;
};

export type ResolveProviderSourceOptions = {
  readonly cacheRoot: string;
  readonly refreshLatest: boolean;
  readonly fetch?: typeof globalThis.fetch;
};

type NpmVersionMetadata = {
  readonly name: string;
  readonly version: string;
  readonly dist: { readonly tarball: string; readonly integrity: string };
};

type NpmPackageMetadata = {
  readonly "dist-tags": { readonly latest: string };
  readonly versions: Readonly<Record<string, NpmVersionMetadata>>;
  readonly time: { readonly modified: string };
};

type LatestPointer = {
  readonly version: string;
  readonly revision: string;
};

const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const declarationPath = /(?:^|\/)package\/(?:package\.json|.*\.d\.[cm]?ts)$/;
const pointerUpdates = new Map<string, Promise<void>>();

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

const validateVersion = (version: unknown): string => {
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    version === "." ||
    version === ".." ||
    version.includes("/") ||
    version.includes("\\") ||
    version.includes("\0") ||
    basename(version) !== version
  ) {
    throw new Error("Invalid npm package version");
  }
  return version;
};

const validateRevision = (revision: unknown): string => {
  if (
    typeof revision !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(revision) ||
    Number.isNaN(Date.parse(revision))
  ) {
    throw new Error("Invalid npm metadata revision");
  }
  return revision;
};

const validVersionMetadata = (value: unknown): value is NpmVersionMetadata => {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<NpmVersionMetadata>;
  return (
    typeof metadata.name === "string" &&
    typeof metadata.version === "string" &&
    !!metadata.dist &&
    typeof metadata.dist.tarball === "string" &&
    typeof metadata.dist.integrity === "string"
  );
};

const validatePackageRoot = async (packageRoot: string, packageName: string, version: string): Promise<void> => {
  const manifest = (await readJson(join(packageRoot, "package.json"))) as { name?: unknown; version?: unknown };
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error(`Invalid manifest for ${packageName}@${version}`);
  }
};

const readLatestPointer = async (packageCache: string): Promise<LatestPointer | undefined> => {
  try {
    const pointer = (await readJson(join(packageCache, "latest.json"))) as Partial<LatestPointer>;
    return {
      version: validateVersion(pointer.version),
      revision: validateRevision(pointer.revision),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const readCachedLatest = async (
  packageCache: string,
  packageName: string,
): Promise<{ readonly version: string; readonly packageRoot: string } | undefined> => {
  const pointer = await readLatestPointer(packageCache);
  if (!pointer) return undefined;
  const packageRoot = join(packageCache, pointer.version, "package");
  try {
    await validatePackageRoot(packageRoot, packageName, pointer.version);
    return { version: pointer.version, packageRoot };
  } catch {
    return undefined;
  }
};

const fetchMetadata = async (packageName: string, fetchImpl: typeof globalThis.fetch): Promise<NpmPackageMetadata> => {
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
  if (!response.ok) throw new Error(`Metadata request returned ${response.status}`);
  const metadata = (await response.json()) as Partial<NpmPackageMetadata>;
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !metadata["dist-tags"] ||
    typeof metadata["dist-tags"].latest !== "string" ||
    !metadata.versions ||
    typeof metadata.versions !== "object" ||
    !metadata.time ||
    typeof metadata.time !== "object"
  ) {
    throw new Error("Invalid npm metadata");
  }
  validateRevision(metadata.time.modified);
  return metadata as NpmPackageMetadata;
};

const downloadTarball = async (
  packageName: string,
  metadata: NpmVersionMetadata,
  fetchImpl: typeof globalThis.fetch,
): Promise<Uint8Array> => {
  const response = await fetchImpl(metadata.dist.tarball);
  if (!response.ok) throw new Error(`Tarball request returned ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_TARBALL_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Tarball exceeds 32 MiB");
  }
  if (!response.body) throw new Error("Tarball response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (totalBytes + value.byteLength > MAX_TARBALL_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Tarball exceeds 32 MiB");
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(Buffer.concat(chunks, totalBytes));

  const match = /^([a-z0-9]+)-([A-Za-z0-9+/]+={0,2})$/.exec(metadata.dist.integrity);
  if (!match) throw new Error("Invalid tarball integrity");
  const algorithm = match[1];
  const encodedDigest = match[2];
  if (!algorithm || !encodedDigest) throw new Error("Invalid tarball integrity");
  const expected = Buffer.from(encodedDigest, "base64");
  let actual: Buffer;
  try {
    actual = createHash(algorithm).update(bytes).digest();
  } catch {
    throw new Error("Invalid tarball integrity algorithm");
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error(`Tarball integrity mismatch for ${packageName}`);
  }
  return bytes;
};

const unsafeArchivePath = (path: string) =>
  isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.split(/[\\/]/).includes("..");

const replaceLatestPointer = async (packageCache: string, candidate: LatestPointer): Promise<void> => {
  const pointerPath = join(packageCache, "latest.json");
  const previous = pointerUpdates.get(pointerPath) ?? Promise.resolve();
  const update = previous
    .catch(() => {})
    .then(async () => {
      const current = await readLatestPointer(packageCache);
      const candidateRevision = Date.parse(candidate.revision);
      const currentRevision = current ? Date.parse(current.revision) : undefined;
      if (
        current &&
        currentRevision !== undefined &&
        (candidateRevision < currentRevision ||
          (candidateRevision === currentRevision && candidate.version !== current.version))
      ) {
        return;
      }

      const temporary = join(packageCache, `.latest-${crypto.randomUUID()}.json`);
      try {
        await writeFile(temporary, JSON.stringify(candidate));
        await rename(temporary, pointerPath);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  pointerUpdates.set(pointerPath, update);
  try {
    await update;
  } finally {
    if (pointerUpdates.get(pointerPath) === update) pointerUpdates.delete(pointerPath);
  }
};

const installVersion = async (
  packageCache: string,
  packageName: string,
  version: string,
  metadata: NpmVersionMetadata,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> => {
  const versionRoot = join(packageCache, version);
  const packageRoot = join(versionRoot, "package");
  try {
    await validatePackageRoot(packageRoot, packageName, version);
    return packageRoot;
  } catch {}

  const temporaryRoot = await mkdtemp(join(packageCache, `.${version}-`));
  const archivePath = join(temporaryRoot, "package.tgz");
  try {
    await writeFile(archivePath, await downloadTarball(packageName, metadata, fetchImpl));
    await mkdir(join(temporaryRoot, "package"));
    let rejectedEntry: string | undefined;
    await tar.x({
      cwd: join(temporaryRoot, "package"),
      file: archivePath,
      preservePaths: false,
      strict: true,
      strip: 1,
      filter(path, entry) {
        if (unsafeArchivePath(path)) {
          rejectedEntry = "unsafe path";
          return false;
        }
        if ("type" in entry && (entry.type === "Link" || entry.type === "SymbolicLink")) {
          rejectedEntry = "link";
          return false;
        }
        return declarationPath.test(path);
      },
    });
    if (rejectedEntry) throw new Error(`Archive ${rejectedEntry} is not allowed for ${packageName}`);
    await rm(archivePath, { force: true });
    await validatePackageRoot(join(temporaryRoot, "package"), packageName, version);
    try {
      await rename(temporaryRoot, versionRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      await validatePackageRoot(packageRoot, packageName, version);
    }
    return packageRoot;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
};

export const resolveProviderSource = async (
  source: ProviderSchemaSource,
  options: ResolveProviderSourceOptions,
): Promise<string> => {
  const { packageName } = source;
  try {
    const packageCache = join(resolve(options.cacheRoot), encodeURIComponent(packageName));
    await mkdir(packageCache, { recursive: true });
    const cachedLatest = await readCachedLatest(packageCache, packageName);
    if (!options.refreshLatest && cachedLatest) return cachedLatest.packageRoot;

    const metadata = await fetchMetadata(packageName, options.fetch ?? globalThis.fetch);
    const version = validateVersion(metadata["dist-tags"].latest);
    const revision = validateRevision(metadata.time.modified);
    const versionMetadata = metadata.versions[version];
    if (
      !validVersionMetadata(versionMetadata) ||
      versionMetadata.name !== packageName ||
      versionMetadata.version !== version
    ) {
      throw new Error("Invalid npm latest version metadata");
    }
    const packageRoot = await installVersion(
      packageCache,
      packageName,
      version,
      versionMetadata,
      options.fetch ?? globalThis.fetch,
    );
    await replaceLatestPointer(packageCache, { version, revision });
    return packageRoot;
  } catch (error) {
    throw new Error(`Failed to resolve ${packageName}: ${errorMessage(error)}`, { cause: error });
  }
};
