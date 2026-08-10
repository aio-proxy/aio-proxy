import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { UpgradeMethod, UpgradeTarget } from './constants';
import { HOMEBREW_FORMULA, PACKAGE } from './constants';

const tryRealpath = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

const isInsideLexical = (filePath: string, dir: string): boolean => {
  const rel = relative(resolve(dir), resolve(filePath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export const isPathInDirectory = (filePath: string, dir: string): boolean => {
  if (isInsideLexical(filePath, dir)) return true;
  const dirReal = tryRealpath(resolve(dir));
  if (dirReal === undefined) return false;
  const fileReal = tryRealpath(resolve(filePath));
  if (fileReal !== undefined && isInsideLexical(fileReal, dirReal)) return true;
  const parentReal = tryRealpath(dirname(resolve(filePath)));
  if (parentReal === undefined) return false;
  return isInsideLexical(join(parentReal, basename(filePath)), dirReal);
};

type UpgradeDirs = { readonly brew?: string; readonly bun?: string; readonly npm?: string; readonly pnpm?: string };

export const resolveUpgradeMethod = (binPath: string, dirs: UpgradeDirs): UpgradeMethod => {
  if (dirs.brew !== undefined && isPathInDirectory(binPath, dirs.brew)) return 'brew';
  if (dirs.bun !== undefined && isPathInDirectory(binPath, dirs.bun)) return 'bun';
  if (dirs.npm !== undefined && isPathInDirectory(binPath, dirs.npm)) return 'npm';
  if (dirs.pnpm !== undefined && isPathInDirectory(binPath, dirs.pnpm)) return 'pnpm';
  return 'binary';
};

const runCapture = async (cmd: [string, ...string[]]): Promise<string | undefined> => {
  const [exe] = cmd;
  if (Bun.which(exe) === null) return undefined;
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return undefined;
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const brewBinDir = async (): Promise<string | undefined> => {
  for (const formula of [HOMEBREW_FORMULA, PACKAGE]) {
    const prefix = await runCapture(['brew', '--prefix', formula]);
    if (prefix !== undefined) return join(prefix, 'bin');
  }
  return undefined;
};

const npmBinDir = async (): Promise<string | undefined> => {
  const prefix = await runCapture(['npm', 'prefix', '-g']);
  if (prefix === undefined) return undefined;
  return process.platform === 'win32' ? prefix : join(prefix, 'bin');
};

const compactDirs = (entries: {
  readonly brew: string | undefined;
  readonly bun: string | undefined;
  readonly npm: string | undefined;
  readonly pnpm: string | undefined;
}): UpgradeDirs => ({
  ...(entries.brew === undefined ? {} : { brew: entries.brew }),
  ...(entries.bun === undefined ? {} : { bun: entries.bun }),
  ...(entries.npm === undefined ? {} : { npm: entries.npm }),
  ...(entries.pnpm === undefined ? {} : { pnpm: entries.pnpm }),
});

export const resolveUpgradeTarget = async (): Promise<UpgradeTarget> => {
  const binPath = Bun.which(PACKAGE);
  if (binPath === null) throw new Error(`cannot locate ${PACKAGE} in PATH`);
  const [brew, bun, npm, pnpm] = await Promise.all([
    brewBinDir(),
    runCapture(['bun', 'pm', 'bin', '-g']),
    npmBinDir(),
    runCapture(['pnpm', 'bin', '-g']),
  ]);
  const method = resolveUpgradeMethod(binPath, compactDirs({ brew, bun, npm, pnpm }));
  return method === 'binary' ? { method, path: binPath } : { method };
};
