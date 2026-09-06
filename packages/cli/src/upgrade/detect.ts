import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import type { PackageUpgradeMethod, UpgradeMethod, UpgradeTarget } from './constants';
import { HOMEBREW_FORMULA, PACKAGE } from './constants';

const PACKAGE_METHODS = ['brew', 'bun', 'npm', 'pnpm'] as const;
const NODE_MANAGERS = ['bun', 'npm', 'pnpm'] as const;
const CELLAR_PATTERN = /^(.*)\/Cellar\/aio-proxy\/[^/]+\/bin\/aio-proxy$/;
const PLATFORM_CLI_BIN = /(?:^|[/\\])node_modules[/\\]@aio-proxy[/\\]cli-[^/\\]+[/\\]bin[/\\]aio-proxy$/;
type NodeManager = (typeof NODE_MANAGERS)[number];

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

export const isPlatformCliBinary = (binPath: string): boolean => PLATFORM_CLI_BIN.test(binPath);

const managerCommandAt = (dir: string, name: string): string | undefined => {
  const inBin = join(dir, 'bin', name);
  if (existsSync(inBin)) return inBin;
  const direct = join(dir, name);
  return existsSync(direct) ? direct : undefined;
};

const launcherBeside = (command: string): string | undefined => {
  const candidate = join(dirname(command), PACKAGE);
  return existsSync(candidate) ? candidate : undefined;
};

const layoutPreferredManager = (binPath: string): NodeManager | undefined => {
  const normalized = binPath.replaceAll('\\', '/');
  if (normalized.includes('/.bun/') || normalized.includes('/install/global/')) return 'bun';
  if (normalized.includes('/.pnpm/') || normalized.includes('/pnpm/')) return 'pnpm';
  if (normalized.includes('/lib/node_modules/')) return 'npm';
  return undefined;
};

const platformPackageTarget = (binPath: string, preferred?: PackageUpgradeMethod): UpgradeTarget | undefined => {
  if (!isPlatformCliBinary(binPath)) return undefined;
  const wanted: readonly NodeManager[] =
    preferred === 'bun' || preferred === 'npm' || preferred === 'pnpm' ? [preferred] : NODE_MANAGERS;
  let dir = dirname(binPath);
  for (let i = 0; i < 16; i++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const matches = wanted.flatMap((name) => {
      const command = managerCommandAt(dir, name);
      return command === undefined ? [] : [{ name, command }];
    });
    if (matches.length === 0) continue;
    const guessed = layoutPreferredManager(binPath);
    const chosen = (guessed === undefined ? undefined : matches.find((entry) => entry.name === guessed)) ?? matches[0];
    if (chosen === undefined) continue;
    const launcher = launcherBeside(chosen.command);
    if (launcher === undefined && preferred === undefined) continue;
    return { method: chosen.name, command: chosen.command, bin: launcher ?? binPath };
  }
  return undefined;
};

const whichOnPath = (name: string): string | undefined => {
  const pathVar = process.env['PATH'];
  if (pathVar === undefined || pathVar === '') return undefined;
  for (const dir of pathVar.split(':')) {
    if (dir === '') continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

const pathLauncherTarget = (preferred?: NodeManager): UpgradeTarget | undefined => {
  const onPath = whichOnPath(PACKAGE);
  if (onPath === undefined || isPlatformCliBinary(onPath)) return undefined;
  if (preferred !== undefined) {
    const command = siblingCommand(onPath, preferred);
    return command === undefined ? undefined : { method: preferred, command, bin: onPath };
  }
  for (const name of NODE_MANAGERS) {
    const command = siblingCommand(onPath, name);
    if (command !== undefined) return { method: name, command, bin: onPath };
  }
  return undefined;
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

const resolvedNodeManagerCommand = (method: NodeManager, binPath: string): UpgradeTarget | undefined => {
  const fromPlatform = platformPackageTarget(binPath, method);
  if (fromPlatform !== undefined) return fromPlatform;
  const sibling = siblingCommand(binPath, method);
  if (sibling !== undefined) return { method, command: sibling, bin: binPath };
  const fromPath = pathLauncherTarget(method);
  if (fromPath !== undefined) return fromPath;
  const which = Bun.which(method);
  return which === null ? undefined : { method, command: which, bin: binPath };
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
  const resolved = resolvedNodeManagerCommand(method, binPath);
  if (resolved === undefined) throw new Error(`${method} binary not found for ${binPath}`);
  return resolved;
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
  const resolved = resolvedNodeManagerCommand(method, binPath);
  if (resolved !== undefined) return resolved;
  if (method === 'npm') return { method, command: method, bin: binPath };
  throw new Error(`${method} binary not found for ${binPath}`);
};

export const resolveUpgradeTargetFrom = async (
  binPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpgradeTarget> => {
  const methodFromEnv = env['AIO_PROXY_UPGRADE_METHOD'];
  if (isPackageMethod(methodFromEnv)) return packageManagerTarget(methodFromEnv, binPath);
  const brew = brewTargetFromCellarOrSibling(binPath);
  if (brew !== undefined) return brew;
  const fromPlatform = platformPackageTarget(binPath);
  if (fromPlatform !== undefined) return fromPlatform;
  if (isPlatformCliBinary(binPath)) {
    const fromPath = pathLauncherTarget();
    if (fromPath !== undefined) return fromPath;
  }
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
