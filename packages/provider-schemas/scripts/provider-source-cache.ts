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
  readonly integrity: string;
};

type CompletionFile = {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
};

type CompletionManifest = {
  readonly packageName: string;
  readonly version: string;
  readonly integrity: string;
  readonly files: readonly CompletionFile[];
};

const MAX_TARBALL_BYTES = 32 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 + 64 * 1024;
const MAX_EXTRACTED_FILES = 65;
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

const validatePackageManifest = async (packageRoot: string, packageName: string, version: string): Promise<void> => {
  const manifest = (await readJson(join(packageRoot, "package.json"))) as { name?: unknown; version?: unknown };
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error(`Invalid manifest for ${packageName}@${version}`);
  }
};

const listPackageFiles = async (packageRoot: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath);
      else if (entry.isFile()) files.push(relativePath);
      else throw new Error(`Invalid cached provider source entry ${relativePath}`);
    }
  };
  await visit(packageRoot, "");
  return files.sort();
};

const fileMetadata = async (packageRoot: string, path: string): Promise<CompletionFile> => {
  const bytes = await readFile(join(packageRoot, path));
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

const createCompletionManifest = async (
  packageRoot: string,
  packageName: string,
  version: string,
  integrity: string,
): Promise<CompletionManifest> => ({
  packageName,
  version,
  integrity,
  files: await Promise.all((await listPackageFiles(packageRoot)).map((path) => fileMetadata(packageRoot, path))),
});

const validateCompletionManifest = (value: unknown): CompletionManifest => {
  if (!value || typeof value !== "object") throw new Error("Invalid provider source completion manifest");
  const completion = value as Partial<CompletionManifest>;
  if (
    typeof completion.packageName !== "string" ||
    typeof completion.version !== "string" ||
    typeof completion.integrity !== "string" ||
    !Array.isArray(completion.files)
  ) {
    throw new Error("Invalid provider source completion manifest");
  }
  const files = completion.files.map((value): CompletionFile => {
    if (!value || typeof value !== "object") throw new Error("Invalid provider source completion file");
    const file = value as Partial<CompletionFile>;
    if (
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      unsafeArchivePath(file.path) ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("Invalid provider source completion file");
    }
    return { path: file.path, size: file.size as number, sha256: file.sha256 };
  });
  const paths = files.map(({ path }) => path);
  if (paths.length === 0 || paths[0] === undefined || !paths.includes("package.json")) {
    throw new Error("Invalid provider source completion files");
  }
  if (
    new Set(paths).size !== paths.length ||
    paths.some((path, index) => {
      const previous = paths[index - 1];
      return previous !== undefined && path < previous;
    })
  ) {
    throw new Error("Invalid provider source completion file order");
  }
  return {
    packageName: completion.packageName,
    version: completion.version,
    integrity: completion.integrity,
    files,
  };
};

const validatePackageRoot = async (
  packageRoot: string,
  packageName: string,
  version: string,
  integrity: string,
): Promise<void> => {
  const completion = validateCompletionManifest(await readJson(resolve(packageRoot, "../completion.json")));
  if (completion.packageName !== packageName || completion.version !== version || completion.integrity !== integrity) {
    throw new Error(`Invalid completion manifest for ${packageName}@${version}`);
  }
  const actualPaths = await listPackageFiles(packageRoot);
  const expectedPaths = completion.files.map(({ path }) => path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(`Cached provider source file set mismatch for ${packageName}@${version}`);
  }
  for (const expected of completion.files) {
    const actual = await fileMetadata(packageRoot, expected.path);
    if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
      throw new Error(`Cached provider source digest mismatch for ${packageName}@${version}:${expected.path}`);
    }
  }
  await validatePackageManifest(packageRoot, packageName, version);
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
  if (typeof observation.integrity !== "string" || observation.integrity.length === 0) {
    throw new Error("Invalid registry observation integrity");
  }
  return { revision, version: validateVersion(observation.version), integrity: observation.integrity };
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
      if (existing.integrity !== observation.integrity) {
        throw new Error(`Registry revision ${observation.revision} resolved to conflicting integrities`);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
};

const readObservations = async (packageCache: string): Promise<RegistryObservation[]> => {
  const observationRoot = join(packageCache, "observations");
  let entries: Dirent[];
  try {
    entries = await readdir(observationRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const observations: RegistryObservation[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".observation-") && entry.name.endsWith(".tmp")) continue;
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) {
      throw new Error("Invalid registry observation entry");
    }
    const observation = validateObservation(await readJson(join(observationRoot, entry.name)), entry.name);
    observations.push(observation);
  }
  return observations.sort((left, right) => right.revision.localeCompare(left.revision));
};

const assertObservationCompatible = async (packageCache: string, candidate: RegistryObservation): Promise<void> => {
  const existing = (await readObservations(packageCache)).find(({ revision }) => revision === candidate.revision);
  if (!existing) return;
  if (existing.version !== candidate.version) {
    throw new Error(`Registry revision ${candidate.revision} resolved to conflicting versions`);
  }
  if (existing.integrity !== candidate.integrity) {
    throw new Error(`Registry revision ${candidate.revision} resolved to conflicting integrities`);
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
    await validatePackageRoot(packageRoot, packageName, version, metadata.dist.integrity);
    return packageRoot;
  } catch {}

  const temporaryRoot = await mkdtemp(join(packageCache, `.${version}-`));
  const archivePath = join(temporaryRoot, "package.tgz");
  try {
    await writeFile(archivePath, await downloadTarball(packageName, metadata, fetchImpl));
    await mkdir(join(temporaryRoot, "package"));
    let rejectedEntry: string | undefined;
    let extractedBytes = 0;
    let extractedFiles = 0;
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
        if ("type" in entry && (entry.type === "Directory" || entry.type === "GNUDumpDir")) return false;
        if (!declarationPath.test(path)) return false;
        extractedFiles += 1;
        if (extractedFiles > MAX_EXTRACTED_FILES) {
          const error = new Error(`Extracted file count limit exceeded for ${packageName}`);
          this.abort(error);
          return false;
        }
        if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
          rejectedEntry = "entry size";
          return false;
        }
        extractedBytes += entry.size;
        if (extractedBytes > MAX_EXTRACTED_BYTES) {
          const error = new Error(`Extracted declaration size limit exceeded for ${packageName}`);
          this.abort(error);
          return false;
        }
        return true;
      },
    });
    if (rejectedEntry) throw new Error(`Archive ${rejectedEntry} is not allowed for ${packageName}`);
    await rm(archivePath, { force: true });
    const extractedPackageRoot = join(temporaryRoot, "package");
    await validatePackageManifest(extractedPackageRoot, packageName, version);
    const completion = await createCompletionManifest(
      extractedPackageRoot,
      packageName,
      version,
      metadata.dist.integrity,
    );
    const completionTemporary = join(temporaryRoot, `.completion-${crypto.randomUUID()}.tmp`);
    await writeFile(completionTemporary, JSON.stringify(completion));
    await rename(completionTemporary, join(temporaryRoot, "completion.json"));
    await validatePackageRoot(extractedPackageRoot, packageName, version, metadata.dist.integrity);
    try {
      await rename(temporaryRoot, versionRoot);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      try {
        await validatePackageRoot(packageRoot, packageName, version, metadata.dist.integrity);
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
      for (const observation of await readObservations(packageCache)) {
        const packageRoot = join(packageCache, observation.version, "package");
        try {
          await validatePackageRoot(packageRoot, packageName, observation.version, observation.integrity);
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
    const observation = { version, revision, integrity: versionMetadata.dist.integrity };
    await assertObservationCompatible(packageCache, observation);
    const packageRoot = await installVersion(
      packageCache,
      packageName,
      version,
      versionMetadata,
      options.fetch ?? globalThis.fetch,
    );
    await publishObservation(packageCache, observation);
    return packageRoot;
  } catch (error) {
    throw new Error(`Failed to resolve ${sourcePackageName}: ${errorMessage(error)}`, { cause: error });
  }
};
