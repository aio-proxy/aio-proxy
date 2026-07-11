import type { Dirent } from "node:fs";
import type * as Tar from "tar";
import { providerSchemasRequire } from "./provider-schemas-require";

const { createHash, timingSafeEqual } = providerSchemasRequire("node:crypto") as typeof import("node:crypto");
const { link, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } = providerSchemasRequire(
  "node:fs/promises",
) as typeof import("node:fs/promises");
const { basename, isAbsolute, join, resolve } = providerSchemasRequire("node:path") as typeof import("node:path");
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

type RegistryObservation = {
  readonly version: string;
  readonly revision: string;
};

const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const declarationPath = /(?:^|\/)package\/(?:package\.json|.*\.d\.[cm]?ts)$/;

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

const validatePackageName = (packageName: string): string => {
  if (!packageName || packageName === "." || packageName === ".." || packageName.includes("\0")) {
    throw new Error("Invalid npm package name");
  }
  return packageName;
};

const packageCacheName = (packageName: string) => `package-${createHash("sha256").update(packageName).digest("hex")}`;

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
  return new Date(revision).toISOString();
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

const observationFileName = (revision: string) => `${createHash("sha256").update(revision).digest("hex")}.json`;

const validateObservation = (value: unknown, fileName: string): RegistryObservation => {
  if (!value || typeof value !== "object") throw new Error("Invalid registry observation");
  const observation = value as Partial<RegistryObservation>;
  const revision = validateRevision(observation.revision);
  if (observation.revision !== revision || observationFileName(revision) !== fileName) {
    throw new Error("Invalid registry observation revision");
  }
  return { revision, version: validateVersion(observation.version) };
};

const publishObservation = async (packageCache: string, observation: RegistryObservation): Promise<void> => {
  const observationRoot = join(packageCache, "observations");
  await mkdir(observationRoot, { recursive: true });
  const fileName = observationFileName(observation.revision);
  const destination = join(observationRoot, fileName);
  const temporary = join(observationRoot, `.observation-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(observation));
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = validateObservation(await readJson(destination), fileName);
      if (existing.version !== observation.version) {
        throw new Error(`Registry revision ${observation.revision} resolved to conflicting versions`);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
};

const readLatestObservation = async (packageCache: string): Promise<RegistryObservation | undefined> => {
  const observationRoot = join(packageCache, "observations");
  let entries: Dirent[];
  try {
    entries = await readdir(observationRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let latest: RegistryObservation | undefined;
  for (const entry of entries) {
    if (entry.name.startsWith(".observation-") && entry.name.endsWith(".tmp")) continue;
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
      throw new Error("Invalid registry observation entry");
    }
    const observation = validateObservation(await readJson(join(observationRoot, entry.name)), entry.name);
    if (!latest || observation.revision > latest.revision) latest = observation;
  }
  return latest;
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
    let sizeLimitError: Error | undefined;
    let extractedBytes = 0;
    try {
      await tar.x({
        cwd: join(temporaryRoot, "package"),
        file: archivePath,
        maxReadSize: 64 * 1024,
        preservePaths: false,
        strict: true,
        strip: 1,
        filter(this: Tar.Unpack, path, entry) {
          if (unsafeArchivePath(path)) {
            rejectedEntry = "unsafe path";
            return false;
          }
          if ("type" in entry && (entry.type === "Link" || entry.type === "SymbolicLink")) {
            rejectedEntry = "link";
            return false;
          }
          if (!declarationPath.test(path)) return false;
          if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
            rejectedEntry = "entry size";
            return false;
          }
          extractedBytes += entry.size;
          if (extractedBytes > MAX_EXTRACTED_BYTES) {
            sizeLimitError = new Error(`Extracted declaration size limit exceeded for ${packageName}`);
            this.abort(sizeLimitError);
            return false;
          }
          return true;
        },
      });
    } catch (error) {
      if (sizeLimitError) throw sizeLimitError;
      throw error;
    }
    if (rejectedEntry) throw new Error(`Archive ${rejectedEntry} is not allowed for ${packageName}`);
    await rm(archivePath, { force: true });
    await validatePackageRoot(join(temporaryRoot, "package"), packageName, version);
    try {
      await rename(temporaryRoot, versionRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      try {
        await validatePackageRoot(packageRoot, packageName, version);
      } catch (validationError) {
        throw new Error(
          `Cached provider source ${packageName}@${version} is invalid; remove the provider schema cache and retry`,
          { cause: validationError },
        );
      }
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
  const { packageName: sourcePackageName } = source;
  try {
    const packageName = validatePackageName(sourcePackageName);
    const packageCache = join(resolve(options.cacheRoot), packageCacheName(packageName));
    await mkdir(packageCache, { recursive: true });
    if (!options.refreshLatest) {
      const observation = await readLatestObservation(packageCache);
      if (observation) {
        const packageRoot = join(packageCache, observation.version, "package");
        try {
          await validatePackageRoot(packageRoot, packageName, observation.version);
          return packageRoot;
        } catch {}
      }
    }

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
    await publishObservation(packageCache, { version, revision });
    return packageRoot;
  } catch (error) {
    throw new Error(`Failed to resolve ${sourcePackageName}: ${errorMessage(error)}`, { cause: error });
  }
};
