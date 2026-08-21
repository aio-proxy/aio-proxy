import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createServerState as createProductionServerState,
  type ServerState,
  type ServerStateOptions,
} from '../src/server-state';
import { createServer as createProductionServer, type AppType, type CreateServerOptions } from '../src/server/server';

const trackedCloses: Array<() => void> = [];
const temporaryHomes: string[] = [];

export function createServerTestHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-server-test-'));
  temporaryHomes.push(home);
  return home;
}

export async function createServer(options: CreateServerOptions): Promise<AppType> {
  const effectiveOptions: CreateServerOptions =
    options.dbHome === undefined && options.configPath === undefined
      ? { ...options, dbHome: createServerTestHome() }
      : options;
  const app = await createProductionServer(effectiveOptions);
  trackedCloses.push(() => app.close());
  return app;
}

export async function createServerState(options: ServerStateOptions): Promise<ServerState> {
  const effectiveOptions: ServerStateOptions =
    options.dbHome === undefined && options.configPath === undefined
      ? { ...options, dbHome: createServerTestHome() }
      : options;
  const state = await createProductionServerState(effectiveOptions);
  trackedCloses.push(() => state.close());
  return state;
}

export function cleanupServerTestLifecycle(): void {
  let firstFailure: unknown;
  for (const close of trackedCloses.splice(0).reverse()) {
    try {
      close();
    } catch (error) {
      if (firstFailure === undefined) firstFailure = error;
    }
  }
  for (const home of temporaryHomes.splice(0).reverse()) {
    try {
      rmSync(home, { force: true, recursive: true });
    } catch (error) {
      if (firstFailure === undefined) firstFailure = error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}
