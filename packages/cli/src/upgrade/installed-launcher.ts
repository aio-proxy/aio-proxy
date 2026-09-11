import { basename, isAbsolute } from 'node:path';

import { isPlatformCliBinary, resolveUpgradeTargetFrom, type LauncherProbeBudget } from './detect';

export { resolveStableManagedExec } from './detect';

const STABLE_NAMES = new Set(['aio-proxy', 'aio-proxy.exe']);

export async function resolveInstalledLauncher(executable: string, probe?: LauncherProbeBudget): Promise<string> {
  const target = await resolveUpgradeTargetFrom(executable, process.env, probe);
  const launcher = target.method === 'binary' ? target.path : target.bin;
  if (!isAbsolute(launcher) || isPlatformCliBinary(launcher) || !STABLE_NAMES.has(basename(launcher))) {
    throw new Error('No stable aio-proxy launcher');
  }
  return launcher;
}
