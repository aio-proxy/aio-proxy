import { type DiagnosticFactory, type PluginRepository, validateModelCatalog } from "@aio-proxy/core";
import { CATALOG_DISCOVERY_TIMEOUT_MS } from "@aio-proxy/plugin-sdk";

import type { CatalogJobDescriptor } from "./plugin-runtime";

export { CATALOG_DISCOVERY_TIMEOUT_MS };
export const CATALOG_RETRY_MS = 5 * 60_000;

type ActiveJob = {
  readonly descriptor: CatalogJobDescriptor;
  readonly generation: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  controller: AbortController | undefined;
};

export type CatalogSchedulerOptions = {
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly rebuild: (reason: "catalog") => Promise<unknown>;
  readonly now?: () => number;
  readonly discoveryTimeoutMs?: number;
  readonly catalogRetryMs?: number;
  readonly rebuildRetryMs?: number;
};

function dueAt(job: CatalogJobDescriptor, now: number, retryMs: number): number | undefined {
  if (job.policy.kind === "static" && job.stored !== null) return undefined;
  const catalogDue =
    job.policy.kind === "static" || job.stored === null ? now : job.stored.refreshedAt + job.policy.ttlMs;
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
      active.controller?.abort(new DOMException("Catalog job replaced", "AbortError"));
    }
    this.#jobs.clear();
    const now = (this.#options.now ?? Date.now)();
    for (const descriptor of descriptors) {
      const active: ActiveJob = { descriptor, generation: this.#generation, timer: undefined, controller: undefined };
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
      active.controller?.abort(new DOMException("Catalog scheduler closed", "AbortError"));
    }
    this.#jobs.clear();
  }

  #current(active: ActiveJob): boolean {
    return !this.#closed && this.#jobs.get(active.descriptor.providerId) === active;
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
      await this.#options.rebuild("catalog");
    } catch {
      this.#scheduleRebuildRetry(active);
    }
  }

  async #run(active: ActiveJob): Promise<void> {
    if (!this.#current(active)) return;
    active.timer = undefined;
    const controller = new AbortController();
    active.controller = controller;
    const deadline = setTimeout(
      () => controller.abort(new DOMException("Catalog discovery timed out", "TimeoutError")),
      this.#options.discoveryTimeoutMs ?? CATALOG_DISCOVERY_TIMEOUT_MS,
    );
    deadline.unref?.();
    let rejectAbort = (_reason: unknown): void => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const discovery = Promise.resolve().then(() => active.descriptor.discover(controller.signal));
    try {
      const catalog = validateModelCatalog(await Promise.race([discovery, aborted]));
      if (!this.#current(active) || controller.signal.aborted) return;
      this.#options.repository.writeCatalog(active.descriptor.providerId, catalog, (this.#options.now ?? Date.now)());
      this.#options.repository.clearDiagnostic(active.descriptor.providerId, "CATALOG_UNAVAILABLE");
    } catch (error) {
      if (!this.#current(active) || (controller.signal.aborted && this.#closed)) return;
      const diagnostic = this.#options.diagnostics("CATALOG_UNAVAILABLE", {
        providerId: active.descriptor.providerId,
        retryable: true,
      });
      this.#options.repository.writeDiagnostic(active.descriptor.providerId, diagnostic);
      if (!this.#current(active)) return;
      await this.#options.rebuild("catalog").catch(() => {});
      if (!this.#current(active)) return;
      active.timer = setTimeout(() => void this.#run(active), this.#options.catalogRetryMs ?? CATALOG_RETRY_MS);
      active.timer.unref?.();
      void error;
      return;
    } finally {
      clearTimeout(deadline);
      controller.signal.removeEventListener("abort", onAbort);
      if (active.controller === controller) active.controller = undefined;
    }
    if (!this.#current(active)) return;
    try {
      await this.#options.rebuild("catalog");
    } catch {
      this.#scheduleRebuildRetry(active);
    }
  }
}
