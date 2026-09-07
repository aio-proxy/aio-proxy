import { readUpdateCheckState, writeUpdateCheckState, type UpdateCheckState } from '@aio-proxy/core';

export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTO_UPDATE_PACKAGE = 'aio-proxy';

export type AutoUpdateSnapshot = {
  readonly status: 'idle' | 'in_progress' | 'failed' | 'restart_required';
  readonly latest?: string;
  readonly outdated: boolean;
};

export type AutoUpdateCheckResult =
  | { readonly current: string; readonly latest: string; readonly outdated: boolean }
  | { readonly status: 'check_failed' };

export type AutoUpdateApplyResult =
  | { readonly status: 'started' }
  | { readonly status: 'up_to_date' }
  | { readonly status: 'in_progress' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'check_failed' };

export type AutoUpdateControllerOptions = {
  readonly isManagedService: () => boolean;
  readonly applyUpdate?: (version: string) => Promise<'installed' | 'unchanged'>;
  readonly notifyAvailable?: (latest: string) => void | Promise<void>;
  readonly currentVersion: string;
  readonly fetchLatest: (pkg: string) => Promise<string>;
  readonly readState?: () => UpdateCheckState | undefined;
  readonly writeState?: (state: UpdateCheckState) => Promise<void>;
  readonly now?: () => number;
  readonly intervalMs?: number;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (id?: unknown) => void;
  readonly onError?: (error: unknown) => void;
};

export type AutoUpdateController = {
  readonly isManagedService: () => boolean;
  readonly snapshot: () => AutoUpdateSnapshot;
  readonly check: () => Promise<AutoUpdateCheckResult>;
  readonly apply: () => Promise<AutoUpdateApplyResult>;
  readonly start: () => void;
  readonly stop: () => void;
};

const isOutdated = (latest: string, current: string): boolean => {
  try {
    return Bun.semver.order(latest, current) > 0;
  } catch {
    return false;
  }
};

export function createAutoUpdateController(options: AutoUpdateControllerOptions): AutoUpdateController {
  const schedule = options.setInterval ?? setInterval;
  const unschedule = options.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  const readState = options.readState ?? readUpdateCheckState;
  const writeState = options.writeState ?? writeUpdateCheckState;
  const now = options.now ?? Date.now;
  let status: AutoUpdateSnapshot['status'] = 'idle';
  let locked = false;
  let stopped = false;
  let timer: unknown;
  let persisted = readState();
  let inFlight: Promise<AutoUpdateCheckResult> | undefined;

  const snapshot = (): AutoUpdateSnapshot => {
    const latest = persisted?.latest;
    return {
      status,
      outdated: latest !== undefined && isOutdated(latest, options.currentVersion),
      ...(latest === undefined ? {} : { latest }),
    };
  };

  const release = (next: AutoUpdateSnapshot['status']) => {
    status = next;
    locked = false;
  };

  const failLookup = (error: unknown) => {
    options.onError?.(error);
    release('failed');
  };

  const startApply = (version: string) => {
    const applyUpdate = options.applyUpdate;
    if (!applyUpdate) {
      release('idle');
      return;
    }
    void (async () => {
      try {
        const result = await applyUpdate(version);
        release(result === 'installed' ? 'restart_required' : 'idle');
      } catch (error) {
        options.onError?.(error);
        release('failed');
      }
    })();
  };

  const persistCheck = async (latest: string): Promise<void> => {
    const previous = persisted;
    const next: UpdateCheckState = {
      latest,
      checkedAt: now(),
      ...(previous?.notifiedVersion === undefined ? {} : { notifiedVersion: previous.notifiedVersion }),
    };
    await writeState(next);
    persisted = next;
    if (!isOutdated(latest, options.currentVersion) || previous?.notifiedVersion === latest) return;
    try {
      await options.notifyAvailable?.(latest);
    } catch (error) {
      options.onError?.(error);
    }
    const notified: UpdateCheckState = { ...next, notifiedVersion: latest };
    await writeState(notified);
    persisted = notified;
  };

  const snapshotAsCheck = (): AutoUpdateCheckResult => {
    const latest = persisted?.latest ?? options.currentVersion;
    return { current: options.currentVersion, latest, outdated: isOutdated(latest, options.currentVersion) };
  };

  const runCheck = async (reportFailure: boolean): Promise<AutoUpdateCheckResult> => {
    if (locked) return snapshotAsCheck();
    let latest: string;
    try {
      latest = await options.fetchLatest(AUTO_UPDATE_PACKAGE);
      Bun.semver.order(latest, options.currentVersion);
    } catch (error) {
      if (reportFailure) options.onError?.(error);
      return { status: 'check_failed' };
    }
    await persistCheck(latest);
    return { current: options.currentVersion, latest, outdated: isOutdated(latest, options.currentVersion) };
  };

  const check = async (): Promise<AutoUpdateCheckResult> => {
    if (inFlight !== undefined) return inFlight;
    inFlight = runCheck(true).finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const tick = async () => {
    if (stopped) return;
    if (inFlight !== undefined) {
      await inFlight;
      return;
    }
    inFlight = runCheck(false).finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  };

  const apply = async (): Promise<AutoUpdateApplyResult> => {
    if (!options.applyUpdate) return { status: 'unavailable' };
    if (locked) return { status: 'in_progress' };
    locked = true;
    status = 'in_progress';
    let latest: string;
    try {
      latest = await options.fetchLatest(AUTO_UPDATE_PACKAGE);
      if (Bun.semver.order(latest, options.currentVersion) <= 0) {
        release('idle');
        return { status: 'up_to_date' };
      }
    } catch (error) {
      failLookup(error);
      return { status: 'check_failed' };
    }
    if (stopped) {
      release('idle');
      return { status: 'unavailable' };
    }
    startApply(latest);
    return { status: 'started' };
  };

  const start = () => {
    stopped = false;
    void tick();
    timer = schedule(() => {
      void tick();
    }, options.intervalMs ?? AUTO_UPDATE_INTERVAL_MS);
  };

  const stop = () => {
    stopped = true;
    if (timer === undefined) return;
    unschedule(timer);
    timer = undefined;
  };

  return {
    isManagedService: options.isManagedService,
    snapshot,
    check,
    apply,
    start,
    stop,
  };
}
