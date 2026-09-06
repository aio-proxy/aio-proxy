import { existsSync, readFileSync } from 'node:fs';

import { isManagedServiceInstalled, managedUnitPath, resolveExec, writeManagedUnit } from '../service/service';
import { resolveStableManagedExec, resolveUpgradeTargetFrom } from '../upgrade/detect';
import { runUpgradeCommand } from '../upgrade/upgrade';

export const isManagedAutoUpdateProcess = (
  env: NodeJS.ProcessEnv = process.env,
  io?: {
    readonly platform?: NodeJS.Platform;
    readonly unitExists?: () => boolean;
  },
): boolean => {
  if (env['AIO_PROXY_MANAGED'] === '1') return true;
  const os = io?.platform ?? process.platform;
  const unitExists = io?.unitExists ?? isManagedServiceInstalled;
  if (os === 'linux') return Boolean(env['INVOCATION_ID']) && unitExists();
  if (os === 'darwin') return env['XPC_SERVICE_NAME'] === 'com.aio-proxy.agent';
  return false;
};

export const createCliAutoUpdateHooks = (deps?: {
  readonly isManagedService?: () => boolean;
  readonly upgrade?: typeof runUpgradeCommand;
  readonly resolveExec?: typeof resolveExec;
  readonly resolveTargetFrom?: typeof resolveUpgradeTargetFrom;
}) => ({
  isManagedService: deps?.isManagedService ?? isManagedAutoUpdateProcess,
  applyUpdate: async (version: string) => {
    const exec = (deps?.resolveExec ?? resolveExec)();
    const resolveTarget = async () => (deps?.resolveTargetFrom ?? resolveUpgradeTargetFrom)(exec);
    return (deps?.upgrade ?? runUpgradeCommand)({ version }, (line) => console.log(line), {
      resolveTarget,
      fetchLatest: async () => version,
      isServiceManaged: deps?.isManagedService ?? isManagedAutoUpdateProcess,
    });
  },
});

export type MigratePreMarkerIo = {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly unitExists?: () => boolean;
  readonly readUnit?: () => string | undefined;
  readonly writeManagedUnit?: (os: 'darwin' | 'linux', exec: string) => Promise<string>;
  readonly resolveExec?: () => string;
  readonly serviceRestart?: () => Promise<void>;
};

export const migratePreMarkerManagedUnit = async (io: MigratePreMarkerIo = {}): Promise<void> => {
  const env = io.env ?? process.env;
  if (env['AIO_PROXY_MANAGED'] === '1') return;
  const os = io.platform ?? process.platform;
  if (os !== 'darwin' && os !== 'linux') return;
  if (!isManagedAutoUpdateProcess(env, { platform: os, unitExists: io.unitExists })) return;
  const body =
    io.readUnit?.() ??
    (() => {
      const path = managedUnitPath(os);
      if (path === undefined || !existsSync(path)) return undefined;
      return readFileSync(path, 'utf8');
    })();
  if (body === undefined || body.includes('AIO_PROXY_MANAGED')) return;
  const exec = resolveStableManagedExec((io.resolveExec ?? resolveExec)());
  await (io.writeManagedUnit ?? writeManagedUnit)(os, exec);
};
