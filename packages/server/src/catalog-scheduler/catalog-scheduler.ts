import {
  type DiagnosticFactory,
  type PluginLogSink,
  type PluginRepository,
  validateModelCatalog,
} from '@aio-proxy/core';
import { CATALOG_DISCOVERY_TIMEOUT_MS, type ModelCatalog } from '@aio-proxy/plugin-sdk';

import type { CatalogJobDescriptor } from '../plugin-runtime';

export { CATALOG_DISCOVERY_TIMEOUT_MS };
export const CATALOG_RETRY_MS = 5 * 60_000;

/** `'unknown'` is `refreshNow` only: no job for that Provider ID, so nothing was attempted. */
export type CatalogRunOutcome = 'refreshed' | 'failed';
export type CatalogRefreshOutcome = CatalogRunOutcome | 'unknown';

type ActiveJob = {
  readonly descriptor: CatalogJobDescriptor;
  readonly generation: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  controller: AbortController | undefined;
  /** The single flight a manual refresh joins instead of issuing a second upstream discovery. */
  inFlight: Promise<CatalogRunOutcome> | undefined;
};

export type CatalogSchedulerOptions = {
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly rebuild: (reason: 'catalog') => Promise<unknown>;
  readonly now?: () => number;
  readonly discoveryTimeoutMs?: number;
  readonly catalogRetryMs?: number;
  readonly rebuildRetryMs?: number;
  readonly logger?: PluginLogSink;
};

function dueAt(job: CatalogJobDescriptor, now: number, retryMs: number): number | undefined {
  // A disabled Provider still gets a job entry so `refreshNow` can reach it, but nothing routes
  // through it, so it is never rediscovered on a timer.
  if (!job.enabled) return undefined;
  if (job.policy.kind === 'static' && job.stored !== null) return undefined;
  const catalogDue =
    job.policy.kind === 'static' || job.stored === null || job.stored.revision === 0
      ? now
      : job.stored.refreshedAt + job.policy.ttlMs;
  const retryDue =
    job.unavailableOccurredAt === undefined ? Number.NEGATIVE_INFINITY : job.unavailableOccurredAt + retryMs;
  return Math.max(now, catalogDue, retryDue);
}

export class CatalogScheduler {
  readonly #options: CatalogSchedulerOptions;
  readonly #jobs = new Map<string, ActiveJob>();
  #generation = 0;
  #closed = false;

  constructor(options: CatalogSchedulerOptions) {
    this.#options = options;
  }

  replaceJobs(descriptors: readonly CatalogJobDescriptor[]): void {
    if (this.#closed) return;
    this.#generation++;
    for (const active of this.#jobs.values()) {
      if (active.timer !== undefined) clearTimeout(active.timer);
      active.controller?.abort(new DOMException('Catalog job replaced', 'AbortError'));
    }
    this.#jobs.clear();
    const now = (this.#options.now ?? Date.now)();
    for (const descriptor of descriptors) {
      const active: ActiveJob = {
        descriptor,
        generation: this.#generation,
        timer: undefined,
        controller: undefined,
        inFlight: undefined,
      };
      this.#jobs.set(descriptor.providerId, active);
      const due = dueAt(descriptor, now, this.#options.catalogRetryMs ?? CATALOG_RETRY_MS);
      if (due === undefined) continue;
      active.timer = setTimeout(() => void this.#run(active), Math.max(0, due - now));
      active.timer.unref?.();
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const active of this.#jobs.values()) {
      if (active.timer !== undefined) clearTimeout(active.timer);
      active.controller?.abort(new DOMException('Catalog scheduler closed', 'AbortError'));
    }
    this.#jobs.clear();
  }

  /**
   * Rediscovers one Provider's catalog now, ignoring the TTL: the TTL only ever lived in `dueAt`, so
   * running the job directly *is* the forced refresh. Awaited to completion — including the snapshot
   * rebuild — so a caller can acknowledge success only once the new catalog is readable.
   *
   * Takes no `AbortSignal`: the flight is shared, and the dashboard tab that started it navigating
   * away must not cancel a refresh other callers are awaiting. `#run` already caps itself at
   * `CATALOG_DISCOVERY_TIMEOUT_MS`.
   */
  async refreshNow(providerId: string): Promise<CatalogRefreshOutcome> {
    if (this.#closed) return 'unknown';
    const active = this.#jobs.get(providerId);
    // No job means account preparation failed for this Provider (bad credential, missing plugin,
    // invalid account options) or it is not an OAuth Provider at all. Nothing to run.
    if (active === undefined) return 'unknown';
    // Joins whatever is already in the air, whether a timer fired it or a previous click did: a
    // second concurrent discovery would hit upstream twice for one intended refresh.
    const inFlight = active.inFlight;
    if (inFlight !== undefined) return await inFlight;
    if (active.timer !== undefined) {
      clearTimeout(active.timer);
      active.timer = undefined;
    }
    // `#run` reschedules on its own — success rebuilds and lands new jobs, failure arms the retry.
    return await this.#run(active);
  }

  #current(active: ActiveJob): boolean {
    return !this.#closed && this.#jobs.get(active.descriptor.providerId) === active;
  }

  #scheduleCatalogRetry(active: ActiveJob): void {
    if (!this.#current(active)) return;
    active.timer = setTimeout(() => void this.#run(active), this.#options.catalogRetryMs ?? CATALOG_RETRY_MS);
    active.timer.unref?.();
  }

  #scheduleRebuildRetry(active: ActiveJob): void {
    if (!this.#current(active)) return;
    active.timer = setTimeout(() => void this.#retryRebuild(active), this.#options.rebuildRetryMs ?? CATALOG_RETRY_MS);
    active.timer.unref?.();
  }

  async #retryRebuild(active: ActiveJob): Promise<void> {
    if (!this.#current(active)) return;
    active.timer = undefined;
    try {
      await this.#options.rebuild('catalog');
    } catch {
      this.#scheduleRebuildRetry(active);
    }
  }

  #run(active: ActiveJob): Promise<CatalogRunOutcome> {
    const flight = this.#runOnce(active).finally(() => {
      if (active.inFlight === flight) active.inFlight = undefined;
    });
    active.inFlight = flight;
    return flight;
  }

  async #runOnce(active: ActiveJob): Promise<CatalogRunOutcome> {
    if (!this.#current(active)) return 'failed';
    active.timer = undefined;
    const startedAt = (this.#options.now ?? Date.now)();
    const controller = new AbortController();
    active.controller = controller;
    const deadline = setTimeout(
      () => controller.abort(new DOMException('Catalog discovery timed out', 'TimeoutError')),
      this.#options.discoveryTimeoutMs ?? CATALOG_DISCOVERY_TIMEOUT_MS,
    );
    deadline.unref?.();
    let rejectAbort = (_reason: unknown): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const discovery = Promise.resolve().then(() => active.descriptor.discover(controller.signal));
    let catalog: ModelCatalog | undefined;
    let swapped: { readonly ok: false } | { readonly ok: true; readonly revision: number } | undefined;
    try {
      catalog = validateModelCatalog(await Promise.race([discovery, aborted]));
      if (!this.#current(active) || controller.signal.aborted) return 'failed';
      swapped = this.#options.repository.compareAndSwapCatalog({
        providerId: active.descriptor.providerId,
        catalog,
        refreshedAt: (this.#options.now ?? Date.now)(),
        startedAt,
        plugin: active.descriptor.plugin,
        capability: active.descriptor.capability,
        accountRuntimeRevision: active.descriptor.accountRuntimeRevision,
      });
    } catch (error) {
      if (!this.#current(active) || (controller.signal.aborted && this.#closed)) return 'failed';
      const wrote = this.#options.repository.writeCatalogUnavailableIfCurrent({
        providerId: active.descriptor.providerId,
        plugin: active.descriptor.plugin,
        capability: active.descriptor.capability,
        accountRuntimeRevision: active.descriptor.accountRuntimeRevision,
        diagnostic: this.#options.diagnostics('CATALOG_UNAVAILABLE', {
          providerId: active.descriptor.providerId,
          retryable: true,
        }),
      });
      if (!this.#current(active)) return 'failed';
      if (wrote) await this.#options.rebuild('catalog').catch(() => {});
      this.#scheduleCatalogRetry(active);
      void error;
      return 'failed';
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener('abort', onAbort);
      if (active.controller === controller) active.controller = undefined;
    }
    if (!this.#current(active)) return 'failed';
    if (swapped?.ok !== true || catalog === undefined) {
      this.#scheduleCatalogRetry(active);
      return 'failed';
    }
    try {
      await this.#options.rebuild('catalog');
    } catch {
      this.#scheduleRebuildRetry(active);
      // The catalog is committed, but generation still routes through the previous snapshot until the
      // retry lands. Acknowledging that as a refresh would let the editor show models the proxy would
      // reject, so the caller is told the refresh did not complete.
      return 'failed';
    }
    return 'refreshed';
  }
}
