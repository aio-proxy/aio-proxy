export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUTO_UPDATE_PACKAGE = 'aio-proxy';

export type AutoUpdateSnapshot = {
  readonly status: 'idle' | 'in_progress' | 'failed' | 'restart_required';
};

export type AutoUpdateApplyResult =
  | { readonly status: 'started' }
  | { readonly status: 'up_to_date' }
  | { readonly status: 'in_progress' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'check_failed' };

export type AutoUpdateControllerOptions = {
  readonly getEnabled: () => boolean;
  readonly isManagedService: () => boolean;
  readonly applyUpdate?: (version: string) => Promise<'installed' | 'unchanged'>;
  readonly currentVersion: string;
  readonly fetchLatest: (pkg: string) => Promise<string>;
  readonly intervalMs?: number;
  readonly setInterval?: (handler: () => void, ms: number) => unknown;
  readonly clearInterval?: (id?: unknown) => void;
  readonly onError?: (error: unknown) => void;
};

export type AutoUpdateController = {
  readonly isManagedService: () => boolean;
  readonly snapshot: () => AutoUpdateSnapshot;
  readonly apply: () => Promise<AutoUpdateApplyResult>;
  readonly notifyCheck: () => void;
  readonly start: () => void;
  readonly stop: () => void;
};

export function createAutoUpdateController(options: AutoUpdateControllerOptions): AutoUpdateController {
  const schedule = options.setInterval ?? setInterval;
  const unschedule = options.clearInterval ?? ((id: unknown) => clearInterval(id as ReturnType<typeof setInterval>));
  let status: AutoUpdateSnapshot['status'] = 'idle';
  let locked = false;
  let stopped = false;
  let timer: unknown;

  const snapshot = (): AutoUpdateSnapshot => ({ status });

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

  const isUpToDate = (latest: string) => Bun.semver.order(latest, options.currentVersion) <= 0;

  const tick = async () => {
    if (stopped || locked || !options.getEnabled() || !options.isManagedService()) return;
    locked = true;
    status = 'in_progress';
    let latest: string;
    try {
      latest = await options.fetchLatest(AUTO_UPDATE_PACKAGE);
      if (isUpToDate(latest)) {
        release('idle');
        return;
      }
    } catch (error) {
      failLookup(error);
      return;
    }
    // Recheck after the awaited lookup: stop() or a toggle-off must not start applyUpdate.
    if (stopped || !options.getEnabled()) {
      release('idle');
      return;
    }
    startApply(latest);
  };

  const apply = async (): Promise<AutoUpdateApplyResult> => {
    if (!options.applyUpdate) return { status: 'unavailable' };
    if (locked) return { status: 'in_progress' };
    locked = true;
    status = 'in_progress';
    let latest: string;
    try {
      latest = await options.fetchLatest(AUTO_UPDATE_PACKAGE);
      if (isUpToDate(latest)) {
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
    if (!options.applyUpdate) return;
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
    apply,
    notifyCheck: () => {
      void tick();
    },
    start,
    stop,
  };
}
