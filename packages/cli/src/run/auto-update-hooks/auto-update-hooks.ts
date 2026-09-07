import { existsSync, readFileSync } from 'node:fs';

import { managedUnitPath, resolveExec, writeManagedUnit } from '../../service/service';
import { SYSTEMD_UNIT_NAME } from '../../service/unit-templates';
import { notifyUpdateAvailable } from '../../update-notify';
import { resolveStableManagedExec, resolveUpgradeTargetFrom } from '../../upgrade/detect';
import { runUpgradeCommand } from '../../upgrade/upgrade';
import { scheduleUnmanagedRelaunch } from './unmanaged-relaunch';

export type ManagedProcessIo = {
  readonly platform?: NodeJS.Platform;
  readonly unitExists?: () => boolean;
  readonly readCgroup?: () => string | undefined;
  readonly isOurSystemdService?: () => boolean;
};

const readSelfCgroup = (): string | undefined => {
  try {
    return readFileSync('/proc/self/cgroup', 'utf8');
  } catch {
    return undefined;
  }
};

const cgroupHasUnitSegment = (cgroup: string, unitName: string): boolean => {
  for (const line of cgroup.split('\n')) {
    const pathStart = line.lastIndexOf(':');
    const path = pathStart === -1 ? line : line.slice(pathStart + 1);
    for (const segment of path.split('/')) {
      if (segment === unitName) return true;
    }
  }
  return false;
};

const isLinuxManagedService = (io?: ManagedProcessIo): boolean => {
  if (io?.isOurSystemdService?.() === true) return true;
  let cgroup: string | undefined;
  try {
    cgroup = (io?.readCgroup ?? readSelfCgroup)();
  } catch {
    return false;
  }
  if (cgroup === undefined || cgroup === '') return false;
  return cgroupHasUnitSegment(cgroup, SYSTEMD_UNIT_NAME);
};

export const isManagedAutoUpdateProcess = (env: NodeJS.ProcessEnv = process.env, io?: ManagedProcessIo): boolean => {
  if (env['AIO_PROXY_MANAGED'] === '1') return true;
  const os = io?.platform ?? process.platform;
  if (os === 'linux') return isLinuxManagedService(io);
  if (os === 'darwin') return env['XPC_SERVICE_NAME'] === 'com.aio-proxy.agent';
  return false;
};

export const createCliAutoUpdateHooks = (deps?: {
  readonly isManagedService?: () => boolean;
  readonly upgrade?: typeof runUpgradeCommand;
  readonly resolveExec?: typeof resolveExec;
  readonly resolveTargetFrom?: typeof resolveUpgradeTargetFrom;
  readonly relaunchUnmanaged?: () => void;
}) => ({
  isManagedService: deps?.isManagedService ?? isManagedAutoUpdateProcess,
  notifyAvailable: (latest: string) => notifyUpdateAvailable(latest),
  applyUpdate: async (version: string) => {
    const isManaged = deps?.isManagedService ?? isManagedAutoUpdateProcess;
    const exec = (deps?.resolveExec ?? resolveExec)();
    const resolveTarget = async () => (deps?.resolveTargetFrom ?? resolveUpgradeTargetFrom)(exec);
    const result = await (deps?.upgrade ?? runUpgradeCommand)({ version }, (line) => console.log(line), {
      resolveTarget,
      fetchLatest: async () => version,
      isServiceManaged: isManaged,
    });
    if (result === 'installed' && !isManaged()) {
      try {
        (deps?.relaunchUnmanaged ?? scheduleUnmanagedRelaunch)();
      } catch {
        // Install already succeeded. The dashboard stays on restart_required until
        // this process is replaced, then falls back to the manual restart hint.
      }
    }
    return result;
  },
});

export type MigratePreMarkerIo = ManagedProcessIo & {
  readonly env?: NodeJS.ProcessEnv;
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
  if (
    !isManagedAutoUpdateProcess(env, {
      platform: os,
      unitExists: io.unitExists,
      readCgroup: io.readCgroup,
      isOurSystemdService: io.isOurSystemdService,
    })
  ) {
    return;
  }
  try {
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
  } catch {
    // Marker rewrite is optional. An unreadable unit, a disappearing file, or a
    // permission / daemon-reload failure must not prevent an otherwise healthy
    // managed process from starting.
  }
};
