import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findInstalledNpmPackage, type NpmPackageInfo } from "./npm";

export type InstalledNpmPackage = NpmPackageInfo & {
  readonly packageName: string;
  readonly cacheDir: string;
};

export async function listInstalledNpmPackages(): Promise<readonly InstalledNpmPackage[]> {
  const packagesRoot = join(homedir(), ".config", "aio-proxy", "cache", "packages");
  if (!existsSync(packagesRoot)) {
    return [];
  }
  const installed: InstalledNpmPackage[] = [];
  for (const cacheEntry of await readdir(packagesRoot, {
    withFileTypes: true,
  })) {
    if (!cacheEntry.isDirectory()) {
      continue;
    }
    const cacheDir = join(packagesRoot, cacheEntry.name);
    const nodeModules = join(cacheDir, "node_modules");
    if (!existsSync(nodeModules)) {
      continue;
    }
    for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
      const names = entry.name.startsWith("@")
        ? (
            await readdir(join(nodeModules, entry.name), {
              withFileTypes: true,
            })
          )
            .filter((child) => child.isDirectory())
            .map((child) => `${entry.name}/${child.name}`)
        : [entry.name];
      for (const packageName of names) {
        const info = await findInstalledNpmPackage(packageName);
        if (info !== null) {
          installed.push({ ...info, cacheDir, packageName });
        }
      }
    }
  }
  return installed.sort((a, b) => a.packageName.localeCompare(b.packageName));
}
