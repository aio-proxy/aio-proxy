import { posix, win32 } from 'node:path';

import { HOMEBREW_FORMULA, PACKAGE, type UpgradeTarget } from './constants';

export const buildBunInstallArgs = (version: string, registry: string): string[] => [
  'add',
  '-g',
  `--registry=${registry}`,
  `${PACKAGE}@${version}`,
];
export const buildNpmInstallArgs = (version: string, registry: string): string[] => [
  'install',
  '-g',
  `--registry=${registry}`,
  `${PACKAGE}@${version}`,
];
export const buildPnpmInstallArgs = (version: string, registry: string): string[] => [
  'add',
  '-g',
  `--registry=${registry}`,
  `${PACKAGE}@${version}`,
];
export const buildHomebrewUpdateArgs = (force: boolean): string[] => [
  force ? 'reinstall' : 'upgrade',
  HOMEBREW_FORMULA,
];

export const interpreterSafePath = (
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  // Windows has no /usr/bin fallbacks, separates with `;`, and may spell the variable `Path`.
  const win = platform === 'win32';
  const parts = win
    ? [win32.dirname(command), env['PATH'] ?? env['Path']]
    : [posix.dirname(command), '/usr/bin', '/bin', env['PATH']];
  return parts.filter((part) => part !== undefined && part !== '').join(win ? ';' : ':');
};

// Inside cmd's quotes `%` still expands variables and `"` would end the quoting; neither has a safe spelling there.
const quoteForCmd = (arg: string): string => {
  if (/["%]/u.test(arg)) throw new Error(`cannot pass ${arg} through cmd.exe`);
  return arg === '' || /[\s&|<>^(),;=!]/u.test(arg) ? `"${arg}"` : arg;
};

/**
 * CreateProcess cannot run a `.cmd`/`.bat` (npm.cmd, pnpm.cmd) itself, so cmd.exe runs it. `/s /c "…"` strips only the
 * outer quotes, so the line must reach cmd verbatim (`windowsVerbatimArguments`).
 */
export const batchFileCommand = (cmd: readonly string[]): string[] => [
  'cmd.exe',
  '/d',
  '/s',
  '/c',
  `"${cmd.map(quoteForCmd).join(' ')}"`,
];

const exec = async (cmd: string[], platform: NodeJS.Platform): Promise<void> => {
  const batch = platform === 'win32' && /\.(?:cmd|bat)$/iu.test(cmd[0] ?? '');
  const proc = Bun.spawn(batch ? batchFileCommand(cmd) : cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, PATH: interpreterSafePath(cmd[0] ?? '', platform) },
    windowsVerbatimArguments: batch,
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd[0]} exited with ${code}`);
};

export const runPackageManagerUpgrade = async (
  target: Exclude<UpgradeTarget, { readonly method: 'binary' }>,
  version: string,
  opts: { readonly registry: string; readonly force: boolean },
  platform: NodeJS.Platform = process.platform,
): Promise<void> => {
  switch (target.method) {
    case 'bun':
      return exec([target.command, ...buildBunInstallArgs(version, opts.registry)], platform);
    case 'npm':
      return exec([target.command, ...buildNpmInstallArgs(version, opts.registry)], platform);
    case 'pnpm':
      return exec([target.command, ...buildPnpmInstallArgs(version, opts.registry)], platform);
    case 'brew':
      await exec([target.command, 'update'], platform);
      return exec([target.command, ...buildHomebrewUpdateArgs(opts.force)], platform);
  }
};
