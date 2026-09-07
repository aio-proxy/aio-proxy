import {
  mergeUpdateCheckState,
  readUpdateCheckState,
  updateCheckPath,
  withUpdateCheckLock,
  writeUpdateCheckState,
  type UpdateCheckState,
} from '@aio-proxy/core';

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
  readonly withLock?: <T>(fn: () => Promise<T>) => Promise<T>;
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
  const checkPath = updateCheckPath();
  const readState = options.readState ?? (() => readUpdateCheckState(checkPath));
  const writeState = options.writeState ?? ((state) => writeUpdateCheckState(state, checkPath));
  const withLock =
    options.withLock ??
    (options.writeState === undefined && options.readState === undefined
      ? (fn) => withUpdateCheckLock(fn, checkPath)
      : async (fn) => fn());
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

  const persistCheck = async (latest: string, fetchStartedAt: number): Promise<void> => {
    let notifyLatest: string | undefined;
    await withLock(async () => {
      const next = mergeUpdateCheckState({ latest, checkedAt: now(), fetchStartedAt }, readState() ?? persisted);
      await writeState(next);
      if (!isOutdated(next.latest, options.currentVersion) || next.notifiedVersion === next.latest) {
        persisted = next;
        return;
      }
      const claimed: UpdateCheckState = { ...next, notifiedVersion: next.latest };
      await writeState(claimed);
      persisted = claimed;
      notifyLatest = claimed.latest;
    });
    if (notifyLatest === undefined) return;
    try {
      await options.notifyAvailable?.(notifyLatest);
    } catch (error) {
      options.onError?.(error);
    }
  };

  const snapshotAsCheck = (): AutoUpdateCheckResult => {
    const latest = persisted?.latest ?? options.currentVersion;
    return { current: options.currentVersion, latest, outdated: isOutdated(latest, options.currentVersion) };
  };

  const runCheck = async (reportFailure: boolean): Promise<AutoUpdateCheckResult> => {
    if (locked) return snapshotAsCheck();
    const fetchStartedAt = now();
    let latest: string;
    try {
      latest = await options.fetchLatest(AUTO_UPDATE_PACKAGE);
      Bun.semver.order(latest, options.currentVersion);
      await persistCheck(latest, fetchStartedAt);
    } catch (error) {
      if (reportFailure) options.onError?.(error);
      return { status: 'check_failed' };
    }
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
    const fetchStartedAt = now();
    let latest: string;
    try {
      latest = await options.fetchLatest(AUTO_UPDATE_PACKAGE);
      if (Bun.semver.order(latest, options.currentVersion) <= 0) {
        await persistCheck(latest, fetchStartedAt);
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
