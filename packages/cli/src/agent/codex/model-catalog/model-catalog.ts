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
      await updateManagedCodexCatalog({ location: options.location, baseUrl, catalog, signal });
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
