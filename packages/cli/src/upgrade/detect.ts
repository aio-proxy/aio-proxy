import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { PackageUpgradeMethod, UpgradeMethod, UpgradeTarget } from './constants';
import { BINARY_NPM_SCOPE, HOMEBREW_FORMULA, PACKAGE, SUPPORTED_BINARY_TARGETS } from './constants';
import { packageOwnsLauncher, packageRootsFor } from './package-ownership';
import { isPathInDirectory, tryRealpath } from './path-in-directory';

export { isPathInDirectory } from './path-in-directory';

const PACKAGE_METHODS = ['brew', 'bun', 'npm', 'pnpm'] as const;
const NODE_MANAGERS = ['bun', 'npm', 'pnpm'] as const;
const CELLAR_PATTERN = /^(.*)\/Cellar\/aio-proxy\/[^/]+\/bin\/aio-proxy$/;
const PLATFORM_CLI_BIN = /(?:^|[/\\])node_modules[/\\]@aio-proxy[/\\]cli-[^/\\]+[/\\]bin[/\\]aio-proxy$/;
type NodeManager = (typeof NODE_MANAGERS)[number];

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

const managerPrefixFromBin = (binPath: string): string => {
  const binDir = dirname(binPath);
  return basename(binDir) === 'bin' ? dirname(binDir) : binDir;
};

// Sibling bun/npm/pnpm is not ownership. A leftover global package directory
// is not enough either: the launcher must resolve into that package.
const nodeManagerOwnsLauncher = (binPath: string, name: NodeManager): boolean => {
  if (layoutPreferredManager(binPath) === name) return true;
  const real = tryRealpath(binPath);
  if (real !== undefined && real !== binPath && layoutPreferredManager(real) === name) return true;
  return packageRootsFor(managerPrefixFromBin(binPath), name).some((dir) => packageOwnsLauncher(binPath, dir));
};

const siblingOwnedTarget = (binPath: string, name: NodeManager): UpgradeTarget | undefined => {
  const command = siblingCommand(binPath, name);
  if (command === undefined || !nodeManagerOwnsLauncher(binPath, name)) return undefined;
  return { method: name, command, bin: binPath };
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

const brewTargetFromCellar = (binPath: string): UpgradeTarget | undefined => {
  const prefix = brewPrefixFromCellar(binPath);
  if (prefix === undefined) return undefined;
  const command = join(prefix, 'bin', 'brew');
  if (!existsSync(command)) throw new Error(`brew binary not found at ${command}`);
  return { method: 'brew', command, bin: join(prefix, 'bin', PACKAGE) };
};

const brewTargetFromResolvedCellar = (binPath: string): UpgradeTarget | undefined => {
  const fromPath = brewTargetFromCellar(binPath);
  if (fromPath !== undefined) return fromPath;
  const real = tryRealpath(binPath);
  if (real === undefined || real === binPath) return undefined;
  return brewTargetFromCellar(real);
};

const brewTargetFromSibling = (binPath: string): UpgradeTarget | undefined => {
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
    const brew = brewTargetFromResolvedCellar(binPath) ?? brewTargetFromSibling(binPath);
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

const detectedPackageTarget = (method: NodeManager, binPath: string): UpgradeTarget => {
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
  const brew = brewTargetFromResolvedCellar(binPath);
  if (brew !== undefined) return brew;
  const fromPlatform = platformPackageTarget(binPath);
  if (fromPlatform !== undefined) return fromPlatform;
  if (isPlatformCliBinary(binPath)) {
    const fromPath = pathLauncherTarget();
    if (fromPath !== undefined) return fromPath;
  }
  const bun = siblingOwnedTarget(binPath, 'bun');
  if (bun !== undefined) return bun;
  const npm = siblingOwnedTarget(binPath, 'npm');
  if (npm !== undefined) return npm;
  const pnpm = siblingOwnedTarget(binPath, 'pnpm');
  if (pnpm !== undefined) return pnpm;
  const [brewDir, bunDir, npmDir, pnpmDir] = await Promise.all([
    brewBinDir(),
    runCapture(['bun', 'pm', 'bin', '-g']),
    npmBinDir(),
    runCapture(['pnpm', 'bin', '-g']),
  ]);
  const method = resolveUpgradeMethod(binPath, compactDirs({ brew: brewDir, bun: bunDir, npm: npmDir, pnpm: pnpmDir }));
  // Prefix-dir containment is not Homebrew: npm's global prefix is often the
  // same as Homebrew's. Only a Cellar path (checked above) is brew. The same
  // prefix is also not npm/bun/pnpm without a package layout.
  if (method === 'binary' || method === 'brew' || !nodeManagerOwnsLauncher(binPath, method)) {
    return { method: 'binary', path: binPath };
  }
  return detectedPackageTarget(method, binPath);
};

const currentPlatformCliPackage = (): string | undefined => {
  const key = `${process.platform}-${process.arch}`;
  if (!(SUPPORTED_BINARY_TARGETS as readonly string[]).includes(key)) return undefined;
  return `${BINARY_NPM_SCOPE}/cli-${key}`;
};

const listDir = (dir: string): readonly string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const nativeAt = (nodeModules: string, platformPkg: string): string | undefined => {
  const candidate = join(nodeModules, platformPkg, 'bin', PACKAGE);
  return existsSync(candidate) ? candidate : undefined;
};

const nativeFromAioProxyPackage = (aioProxyDir: string, platformPkg: string): string | undefined => {
  if (!existsSync(aioProxyDir)) return undefined;
  const nested = nativeAt(join(aioProxyDir, 'node_modules'), platformPkg);
  if (nested !== undefined) return nested;
  const real = tryRealpath(aioProxyDir);
  if (real === undefined || real === aioProxyDir) return undefined;
  return nativeAt(join(real, 'node_modules'), platformPkg);
};

const scanPnpmVirtualStore = (nodeModules: string, platformPkg: string): string | undefined => {
  const store = join(nodeModules, '.pnpm');
  const marker = `${platformPkg.replace('/', '+')}@`;
  let best: { readonly version: string; readonly path: string } | undefined;
  for (const entry of listDir(store)) {
    if (!entry.startsWith(marker)) continue;
    const version = entry.slice(marker.length).split('_')[0];
    if (version === undefined || version === '') continue;
    try {
      Bun.semver.order(version, '0.0.0');
    } catch {
      continue;
    }
    const candidate = nativeAt(join(store, entry, 'node_modules'), platformPkg);
    if (candidate === undefined) continue;
    if (best === undefined || Bun.semver.order(version, best.version) > 0) best = { version, path: candidate };
  }
  return best?.path;
};

const nativeInNodeModules = (nodeModules: string, platformPkg: string): string | undefined => {
  if (!existsSync(nodeModules)) return undefined;
  const hoisted = nativeAt(nodeModules, platformPkg);
  if (hoisted !== undefined) return hoisted;
  const throughPackage = nativeFromAioProxyPackage(join(nodeModules, PACKAGE), platformPkg);
  if (throughPackage !== undefined) return throughPackage;
  return scanPnpmVirtualStore(nodeModules, platformPkg);
};

const nativeUnderPnpmGlobal = (dir: string, platformPkg: string): string | undefined => {
  const globalDir = join(dir, 'global');
  if (!existsSync(globalDir)) return undefined;
  const fromRoot = nativeInNodeModules(join(globalDir, 'node_modules'), platformPkg);
  if (fromRoot !== undefined) return fromRoot;
  for (const entry of listDir(globalDir)) {
    if (entry === 'store') continue;
    const entryDir = join(globalDir, entry);
    const found = nativeInNodeModules(join(entryDir, 'node_modules'), platformPkg);
    if (found !== undefined) return found;
    for (const nested of listDir(entryDir)) {
      if (nested === 'store') continue;
      const nestedFound = nativeInNodeModules(join(entryDir, nested, 'node_modules'), platformPkg);
      if (nestedFound !== undefined) return nestedFound;
    }
  }
  return undefined;
};

const findPlatformCliBinaryNear = (startDir: string): string | undefined => {
  const platformPkg = currentPlatformCliPackage();
  if (platformPkg === undefined) return undefined;
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const found =
      nativeInNodeModules(join(dir, 'node_modules'), platformPkg) ??
      nativeInNodeModules(join(dir, 'lib', 'node_modules'), platformPkg) ??
      nativeInNodeModules(join(dir, 'install', 'global', 'node_modules'), platformPkg) ??
      nativeUnderPnpmGlobal(dir, platformPkg);
    if (found !== undefined) return found;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
};

export const resolveManagedRestartExec = (target: UpgradeTarget): string | undefined => {
  if (target.method === 'brew') return target.bin;
  if (target.method === 'binary') return resolveStableManagedExec(target.path);
  return findPlatformCliBinaryNear(dirname(target.bin)) ?? findPlatformCliBinaryNear(dirname(target.command));
};

export const resolveUpgradeTarget = async (): Promise<UpgradeTarget> => {
  const binPath = Bun.which(PACKAGE);
  if (binPath === null) throw new Error(`cannot locate ${PACKAGE} in PATH`);
  return resolveUpgradeTargetFrom(binPath);
};
