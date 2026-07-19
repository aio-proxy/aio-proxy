import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { z } from "zod";

import { NpmInstallError, NpmPackageEntrypointError, NpmPackageJsonError, NpmPackageNameError } from "./error";
import { acquireNpmInstallLock } from "./npm-lock";
import { packagesDir } from "./paths";

const REGISTRY = "https://registry.npmjs.org";
const INSTALL_TIMEOUT_MS = 120_000;

const PackageJsonSchema = z
  .object({
    name: z.string().optional(),
    version: z.string(),
    main: z.string().optional(),
    module: z.string().optional(),
    exports: z.unknown().optional(),
  })
  .passthrough();

type PackageJson = z.infer<typeof PackageJsonSchema>;

export type NpmPackageInfo = {
  readonly entrypoint: string;
  readonly version: string;
};

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && error.code === code;
}

function packageNameParts(pkg: string): readonly string[] {
  const scoped = /^@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*$/i;
  const unscoped = /^[a-z0-9][a-z0-9._~-]*$/i;
  if (scoped.test(pkg) || unscoped.test(pkg)) {
    return pkg.split("/");
  }
  throw new NpmPackageNameError(pkg);
}

export function isNpmPackageName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    packageNameParts(value);
    return true;
  } catch (error) {
    if (error instanceof NpmPackageNameError) return false;
    throw error;
  }
}

export function npmPackageCacheDir(pkg: string): string {
  packageNameParts(pkg);
  return join(packagesDir(), encodeURIComponent(pkg));
}

function packageJsonPath(pkg: string): string {
  return join(npmPackageCacheDir(pkg), "node_modules", ...packageNameParts(pkg), "package.json");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exportPath(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of [".", "import", "module", "default", "require"] as const) {
    const found = exportPath(value[key]);
    if (found !== undefined) {
      return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = exportPath(child);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function resolveEntrypoint(pkg: string, packageJson: PackageJson, path: string): string {
  const packageDir = dirname(path);
  const raw = packageJson.module ?? packageJson.main ?? exportPath(packageJson.exports) ?? "index.js";
  const entrypoint = normalize(join(packageDir, raw));
  if (entrypoint !== packageDir && !entrypoint.startsWith(`${packageDir}${sep}`)) {
    throw new NpmPackageEntrypointError(pkg);
  }
  return entrypoint;
}

function parsePackageJson(text: string, path: string): PackageJson {
  try {
    const parsed = PackageJsonSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
  }
  throw new NpmPackageJsonError(path);
}

export async function findInstalledNpmPackage(pkg: string): Promise<NpmPackageInfo | null> {
  const path = packageJsonPath(pkg);
  if (!existsSync(path)) {
    return null;
  }
  const parsed = parsePackageJson(await readFile(path, "utf8"), path);
  return {
    entrypoint: resolveEntrypoint(pkg, parsed, path),
    version: parsed.version,
  };
}

async function runInstall(pkg: string, registry: string, cacheDir: string): Promise<void> {
  try {
    await writeFile(join(cacheDir, "package.json"), '{"private":true}\n', {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isNodeCode(error, "EEXIST")) {
      throw error;
    }
  }
  const child = Bun.spawn([process.execPath, "add", pkg, "--no-save"], {
    cwd: cacheDir,
    env: {
      ...process.env,
      BUN_BE_BUN: "1",
      BUN_INSTALL_REGISTRY: registry,
      NPM_CONFIG_REGISTRY: registry,
      npm_config_registry: registry,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, INSTALL_TIMEOUT_MS);
  const stdout = child.stdout;
  const stderr = child.stderr;
  const [out, err, code] = await Promise.all([
    stdout === null ? "" : new Response(stdout).text(),
    stderr === null ? "" : new Response(stderr).text(),
    child.exited,
  ]);
  clearTimeout(timeout);
  if (code !== 0) {
    throw new NpmInstallError(pkg, timedOut ? null : code, `${out}${err}`);
  }
}

export async function npmAdd(pkg: string, registry: string = REGISTRY): Promise<NpmPackageInfo> {
  return withNpmPackageLifecycle(pkg, async () => {
    const hit = await findInstalledNpmPackage(pkg);
    return hit ?? ensureInstalledNpmPackage(pkg, registry);
  });
}

async function ensureInstalledNpmPackage(pkg: string, registry: string): Promise<NpmPackageInfo> {
  const cacheDir = npmPackageCacheDir(pkg);
  const lock = await acquireNpmInstallLock(pkg, cacheDir);
  try {
    return await lock.withOwnership(async (assertOwnership) => {
      const lockedHit = await findInstalledNpmPackage(pkg);
      if (lockedHit !== null) return lockedHit;
      await assertOwnership();
      await runInstall(pkg, registry, cacheDir);
      await assertOwnership();
      const installed = await findInstalledNpmPackage(pkg);
      if (installed === null) {
        throw new NpmPackageJsonError(packageJsonPath(pkg));
      }
      return installed;
    });
  } finally {
    await lock.release();
  }
}

export async function withNpmPackageLifecycle<T>(
  pkg: string,
  use: (assertOwnership: () => Promise<void>) => Promise<T>,
): Promise<T> {
  const lockDir = join(packagesDir(), ".locks", encodeURIComponent(pkg));
  const lock = await acquireNpmInstallLock(pkg, lockDir);
  try {
    return await lock.withOwnership(use);
  } finally {
    await lock.release();
  }
}

export async function withInstalledNpmPackage<T>(
  pkg: string,
  registry: string | undefined,
  use: (installed: NpmPackageInfo, assertOwnership: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return withNpmPackageLifecycle(pkg, async (assertOwnership) => {
    const installed = await ensureInstalledNpmPackage(pkg, registry ?? REGISTRY);
    await assertOwnership();
    return use(installed, assertOwnership);
  });
}

export async function removeNpmPackageCache(pkg: string, canRemove?: () => Promise<boolean>): Promise<boolean> {
  const cacheDir = npmPackageCacheDir(pkg);
  if (!existsSync(cacheDir)) return false;
  return withNpmPackageLifecycle(pkg, async (assertOwnership) => {
    if (canRemove !== undefined && !(await canRemove())) return false;
    if (!existsSync(cacheDir)) return false;
    await assertOwnership();
    await rm(cacheDir, { recursive: true, force: true });
    return true;
  });
}
