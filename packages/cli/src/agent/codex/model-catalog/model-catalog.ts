import type { CodexCatalogSyncFactory } from '@aio-proxy/server';

import { codexBaseUrl } from '../../control-plane';
import type { CodexLocation } from '../contracts';
import {
  canUpdateManagedCodexCatalog,
  recoverCodexConfigOperation,
  updateManagedCodexCatalog,
} from '../managed-config';
import { withCodexInstallation } from '../storage/installation-lock';
import { inspectDirectory } from '../storage/storage';

export type LocalCodexCatalogSyncOptions = {
  readonly location: CodexLocation;
  readonly endpoint: string;
  readonly onError: (error: unknown) => void;
  readonly clock?: { readonly setInterval: (callback: () => void, ms: number) => { readonly clear: () => void } };
};

/** Reported through `onError` when the server produced a catalog without models and nothing was written. */
export const CODEX_CATALOG_EMPTY = 'CODEX_CATALOG_EMPTY';

const clock = {
  setInterval(callback: () => void, ms: number) {
    const timer = setInterval(callback, ms);
    timer.unref();
    return { clear: () => clearInterval(timer) };
  },
};

export function createLocalCodexCatalogSync(options: LocalCodexCatalogSyncOptions): CodexCatalogSyncFactory {
  return (source) => {
    const controller = new AbortController();
    const { signal } = controller;
    const baseUrl = codexBaseUrl(options.endpoint);
    let running = false;
    let dirty = false;

    async function synchronize(): Promise<void> {
      signal.throwIfAborted();
      // Do not create a home, managed root or lock for users who never connected Codex.
      if ((await inspectDirectory(options.location.managedRoot)) === undefined) return;
      const eligible = await withCodexInstallation(options.location, signal, async (lease) => {
        await recoverCodexConfigOperation(options.location, undefined, lease);
        return canUpdateManagedCodexCatalog(options.location, baseUrl, lease);
      });
      if (!eligible) return;
      signal.throwIfAborted();
      const catalog = await source.load(signal);
      signal.throwIfAborted();
      // The updater reacquires its lease, recovers, and rechecks after this asynchronous load.
      const result = await updateManagedCodexCatalog({ location: options.location, baseUrl, catalog, signal });
      // The cause is not reported: an empty catalog is indistinguishable here between no text
      // models being enabled and model metadata being unavailable, which only the server can tell.
      if (result === 'empty') throw new Error(CODEX_CATALOG_EMPTY);
    }

    async function drain(): Promise<void> {
      try {
        do {
          dirty = false;
          try {
            await synchronize();
          } catch (error) {
            if (!signal.aborted) {
              try {
                options.onError(error);
              } catch {}
            }
          }
        } while (dirty && !signal.aborted);
      } finally {
        running = false;
      }
    }

    const schedule = (): void => {
      if (signal.aborted) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      // drain owns every asynchronous failure, including failures of the diagnostic callback.
      void drain();
    };
    const timer = (options.clock ?? clock).setInterval(schedule, 6 * 60 * 60_000);
    return {
      schedule,
      close() {
        if (signal.aborted) return;
        controller.abort();
        timer.clear();
      },
    };
  };
}
