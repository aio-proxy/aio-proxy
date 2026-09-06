import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { PackageUpgradeMethod, UpgradeMethod, UpgradeTarget } from './constants';
import { HOMEBREW_FORMULA, PACKAGE } from './constants';

const PACKAGE_METHODS = ['brew', 'bun', 'npm', 'pnpm'] as const;
const CELLAR_PATTERN = /^(.*)\/Cellar\/aio-proxy\/[^/]+\/bin\/aio-proxy$/;

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

const isPackageMethod = (value: string | undefined): value is PackageUpgradeMethod =>
  PACKAGE_METHODS.some((method) => method === value);

const brewPrefixFromCellar = (binPath: string): string | undefined => CELLAR_PATTERN.exec(binPath)?.[1];

export const resolveStableManagedExec = (execPath: string): string => {
  const prefix = brewPrefixFromCellar(execPath);
  return prefix === undefined ? execPath : join(prefix, 'bin', PACKAGE);
};

const siblingCommand = (binPath: string, name: string): string | undefined => {
  const candidate = join(dirname(binPath), name);
  return existsSync(candidate) ? candidate : undefined;
};

const brewTargetFromCellarOrSibling = (binPath: string): UpgradeTarget | undefined => {
  const prefix = brewPrefixFromCellar(binPath);
  if (prefix !== undefined) {
    const command = join(prefix, 'bin', 'brew');
    if (!existsSync(command)) throw new Error(`brew binary not found at ${command}`);
    return { method: 'brew', command, bin: join(prefix, 'bin', PACKAGE) };
  }
  const command = siblingCommand(binPath, 'brew');
  return command === undefined ? undefined : { method: 'brew', command, bin: binPath };
};

const packageManagerTarget = (method: PackageUpgradeMethod, binPath: string): UpgradeTarget => {
  if (method === 'brew') {
    const brew = brewTargetFromCellarOrSibling(binPath);
    if (brew !== undefined) return brew;
    const prefix = basename(dirname(binPath)) === 'bin' ? dirname(dirname(binPath)) : undefined;
    if (prefix !== undefined) {
      const command = join(prefix, 'bin', 'brew');
      if (!existsSync(command)) throw new Error(`brew binary not found at ${command}`);
      return { method: 'brew', command, bin: join(prefix, 'bin', PACKAGE) };
    }
    throw new Error(`brew binary not found for ${binPath}`);
  }
  const command = siblingCommand(binPath, method) ?? Bun.which(method) ?? method;
  return { method, command, bin: binPath };
};

const detectedPackageTarget = (method: PackageUpgradeMethod, binPath: string): UpgradeTarget => {
  if (method === 'brew') {
    const fromPath = brewTargetFromCellarOrSibling(binPath);
    if (fromPath !== undefined) return fromPath;
    const real = tryRealpath(binPath);
    if (real !== undefined && real !== binPath) {
      const fromReal = brewTargetFromCellarOrSibling(real);
      if (fromReal !== undefined) return fromReal;
    }
    const command = Bun.which('brew');
    if (command === null) throw new Error(`brew binary not found for ${binPath}`);
    return { method: 'brew', command, bin: binPath };
  }
  return packageManagerTarget(method, binPath);
};

export const resolveUpgradeTargetFrom = async (
  binPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpgradeTarget> => {
  const methodFromEnv = env['AIO_PROXY_UPGRADE_METHOD'];
  if (isPackageMethod(methodFromEnv)) return packageManagerTarget(methodFromEnv, binPath);
  const brew = brewTargetFromCellarOrSibling(binPath);
  if (brew !== undefined) return brew;
  const bun = siblingCommand(binPath, 'bun');
  if (bun !== undefined) return { method: 'bun', command: bun, bin: binPath };
  const npm = siblingCommand(binPath, 'npm');
  if (npm !== undefined) return { method: 'npm', command: npm, bin: binPath };
  const pnpm = siblingCommand(binPath, 'pnpm');
  if (pnpm !== undefined) return { method: 'pnpm', command: pnpm, bin: binPath };
  const [brewDir, bunDir, npmDir, pnpmDir] = await Promise.all([
    brewBinDir(),
    runCapture(['bun', 'pm', 'bin', '-g']),
    npmBinDir(),
    runCapture(['pnpm', 'bin', '-g']),
  ]);
  const method = resolveUpgradeMethod(binPath, compactDirs({ brew: brewDir, bun: bunDir, npm: npmDir, pnpm: pnpmDir }));
  if (method === 'binary') return { method, path: binPath };
  return detectedPackageTarget(method, binPath);
};

export const resolveUpgradeTarget = async (): Promise<UpgradeTarget> => {
  const binPath = Bun.which(PACKAGE);
  if (binPath === null) throw new Error(`cannot locate ${PACKAGE} in PATH`);
  return resolveUpgradeTargetFrom(binPath);
};
