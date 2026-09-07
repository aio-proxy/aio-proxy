import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { isPlainObject } from 'es-toolkit/predicate';

import { PACKAGE } from './constants';
import { isPathInDirectory, tryRealpath } from './path-in-directory';

export type NodeManager = 'bun' | 'npm' | 'pnpm';

const listDir = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const pnpmPackageRoots = (prefix: string): readonly string[] => {
  const roots = [join(prefix, 'global', 'node_modules', PACKAGE), join(prefix, 'node_modules', PACKAGE)];
  const globalDir = join(prefix, 'global');
  const extra: string[] = [];
  for (const entry of listDir(globalDir)) {
    if (entry === 'store') continue;
    extra.push(join(globalDir, entry, 'node_modules', PACKAGE));
    const entryDir = join(globalDir, entry);
    for (const nested of listDir(entryDir)) {
      if (nested === 'store') continue;
      extra.push(join(entryDir, nested, 'node_modules', PACKAGE));
    }
  }
  return [...roots, ...extra];
};

export const packageRootsFor = (prefix: string, name: NodeManager): readonly string[] => {
  if (name === 'npm') return [join(prefix, 'lib', 'node_modules', PACKAGE), join(prefix, 'node_modules', PACKAGE)];
  if (name === 'bun') {
    return [join(prefix, 'install', 'global', 'node_modules', PACKAGE), join(prefix, 'node_modules', PACKAGE)];
  }
  return pnpmPackageRoots(prefix);
};

const packageBinTargets = (packageDir: string): readonly string[] => {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
    if (!isPlainObject(raw)) return [];
    const bin = raw['bin'];
    if (typeof bin === 'string') return [resolve(packageDir, bin)];
    if (!isPlainObject(bin)) return [];
    return Object.values(bin).flatMap((value) => (typeof value === 'string' ? [resolve(packageDir, value)] : []));
  } catch {
    return [];
  }
};

// pnpm writes a regular shell launcher (cmd-shim). realpath is the shim
// itself; ownership is an exec target that resolves inside the package.
const MAX_SHIM_BYTES = 64 * 1024;

const readLauncherShim = (binPath: string): string | undefined => {
  try {
    const raw = readFileSync(binPath);
    if (raw.length === 0 || raw.length > MAX_SHIM_BYTES) return undefined;
    if (raw[0] !== 0x23 || raw[1] !== 0x21) return undefined;
    return raw.toString('utf8');
  } catch {
    return undefined;
  }
};

const shimReferencesPackageBin = (binPath: string, packageDir: string): boolean => {
  const text = readLauncherShim(binPath);
  if (text === undefined) return false;
  const launcherDir = dirname(binPath);
  return packageBinTargets(packageDir).some((target) => {
    const candidates = new Set<string>([resolve(target)]);
    const real = tryRealpath(target);
    if (real !== undefined) candidates.add(real);
    for (const abs of candidates) {
      if (text.includes(abs)) return true;
      const rel = relative(launcherDir, abs).replaceAll('\\', '/');
      if (rel !== '' && !rel.startsWith('/') && text.includes(rel)) return true;
    }
    return false;
  });
};

export const packageOwnsLauncher = (binPath: string, packageDir: string): boolean => {
  if (!existsSync(join(packageDir, 'package.json'))) return false;
  if (isPathInDirectory(binPath, packageDir)) return true;
  const launcherReal = tryRealpath(binPath);
  if (launcherReal !== undefined && isPathInDirectory(launcherReal, packageDir)) return true;
  const resolved = launcherReal ?? resolve(binPath);
  if (packageBinTargets(packageDir).some((target) => (tryRealpath(target) ?? resolve(target)) === resolved)) {
    return true;
  }
  return shimReferencesPackageBin(binPath, packageDir);
};
