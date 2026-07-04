import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { z } from "zod";
import { NpmInstallError, NpmPackageEntrypointError, NpmPackageJsonError, NpmPackageNameError } from "./error";
import { acquireNpmInstallLock } from "./npm-lock";

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

export function npmPackageCacheDir(pkg: string): string {
  packageNameParts(pkg);
  return join(homedir(), ".config", "aio-proxy", "cache", "packages", encodeURIComponent(pkg));
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
  const hit = await findInstalledNpmPackage(pkg);
  if (hit !== null) {
    return hit;
  }

  const cacheDir = npmPackageCacheDir(pkg);
  const lock = await acquireNpmInstallLock(pkg, cacheDir);
  try {
    const lockedHit = await findInstalledNpmPackage(pkg);
    if (lockedHit !== null) {
      return lockedHit;
    }
    await runInstall(pkg, registry, cacheDir);
    const installed = await findInstalledNpmPackage(pkg);
    if (installed === null) {
      throw new NpmPackageJsonError(packageJsonPath(pkg));
    }
    return installed;
  } finally {
    await lock.release();
  }
}
