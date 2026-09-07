import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { isPlainObject } from 'es-toolkit/predicate';

import { PACKAGE } from './constants';
import { isPathInDirectory, tryRealpath } from './path-in-directory';

export type NodeManager = 'bun' | 'npm' | 'pnpm';

export const packageRootsFor = (prefix: string, name: NodeManager): readonly string[] => {
  if (name === 'npm') return [join(prefix, 'lib', 'node_modules', PACKAGE), join(prefix, 'node_modules', PACKAGE)];
  if (name === 'bun') {
    return [join(prefix, 'install', 'global', 'node_modules', PACKAGE), join(prefix, 'node_modules', PACKAGE)];
  }
  return [join(prefix, 'global', 'node_modules', PACKAGE), join(prefix, 'node_modules', PACKAGE)];
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

export const packageOwnsLauncher = (binPath: string, packageDir: string): boolean => {
  if (!existsSync(join(packageDir, 'package.json'))) return false;
  if (isPathInDirectory(binPath, packageDir)) return true;
  const launcherReal = tryRealpath(binPath);
  if (launcherReal !== undefined && isPathInDirectory(launcherReal, packageDir)) return true;
  const resolved = launcherReal ?? resolve(binPath);
  return packageBinTargets(packageDir).some((target) => (tryRealpath(target) ?? resolve(target)) === resolved);
};
