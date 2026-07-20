import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { findInstalledNpmPackage, type NpmPackageInfo } from "./npm";
import { packagesDir } from "./paths/index";

export type InstalledNpmPackage = NpmPackageInfo & {
  readonly packageName: string;
  readonly cacheDir: string;
};

export async function listInstalledNpmPackages(): Promise<readonly InstalledNpmPackage[]> {
  const packagesRoot = packagesDir();
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
    let packageName: string;
    try {
      packageName = decodeURIComponent(cacheEntry.name);
    } catch {
      continue;
    }
    const info = await findInstalledNpmPackage(packageName).catch(() => null);
    if (info !== null) installed.push({ ...info, cacheDir: join(packagesRoot, cacheEntry.name), packageName });
  }
  return installed.sort((a, b) => a.packageName.localeCompare(b.packageName));
}
