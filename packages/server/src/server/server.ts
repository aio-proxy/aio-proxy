import { fetchLatestNpmVersion, parseRuntimeConfig } from '@aio-proxy/core';

import { createAutoUpdateController } from '../auto-update';
import { warnLeftoverOAuthModels } from '../config-leftover-oauth-models';
import type { DashboardAssets } from '../dashboard-assets';
import { prepareDashboardConfig } from '../dashboard-auth';
import type { DashboardEventLimits } from '../dashboard-events';
import type { RuntimeProviderInput } from '../runtime';
import type { ServerLogSink } from '../server-log';
import { logServerEvent, serverErrorType } from '../server-log';
import { createServerState } from '../server-state';
import { defaultLogger } from '../server-state/logging';
import type { InternalServerStateOptions, ServerStateTestHooks } from '../server-state/types';
import { createRoutes } from './create-routes';
import { serverDefaults } from './defaults';

/** The Bun WebSocket handler the realtime routes' `upgradeWebSocket` needs at the
 *  `Bun.serve` call site. `createServer` returns `Object.assign(routes, { close })`, so this
 *  cannot ride on the app object and has to be a module-level export. Hono exports it as a
 *  module singleton shared by every importer, so a call site must spread it, never mutate it. */
export { websocket } from 'hono/bun';

export { serverDefaults };

export type CreateServerOptions = {
  readonly __test?: ServerStateTestHooks & { readonly createRoutes?: typeof createRoutes };
  readonly config: unknown;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly providerInstances?: readonly RuntimeProviderInput[];
  readonly port?: number;
  readonly host?: string;
  readonly dashboardAssets?: DashboardAssets;
  readonly logger?: ServerLogSink;
  readonly watchConfig?: boolean;
  readonly version?: string;
  readonly autoUpdate?: {
    readonly isManagedService: () => boolean;
    readonly applyUpdate: (version: string) => Promise<'installed' | 'unchanged'>;
    readonly notifyAvailable?: (latest: string) => void | Promise<void>;
    readonly fetchLatest?: (pkg: string) => Promise<string>;
  };
};

export type AppType = ReturnType<typeof createRoutes>;

export const createServer = async (options: CreateServerOptions): Promise<AppType & { readonly close: () => void }> => {
  const prepared = await prepareDashboardConfig(options.config, options.configPath);
  let dashboardAuthAvailable = !prepared.dashboardUnavailable;
  if (prepared.error !== undefined) {
    const error: unknown = prepared.error;
    logServerEvent(options.logger ?? defaultLogger, {
      error: error instanceof Error ? error.message : String(error),
      errorType: serverErrorType(error),
      event: 'dashboard.auth_unavailable',
    });
  }
  const config = parseRuntimeConfig(prepared.config);
  warnLeftoverOAuthModels(prepared.config, options.logger ?? defaultLogger);
  const stateOptions: InternalServerStateOptions = {
    config,
    __dashboardAuthHealthChanged: (available) => {
      dashboardAuthAvailable = available;
    },
    ...(options.__test === undefined ? {} : { __test: options.__test }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.dbHome === undefined ? {} : { dbHome: options.dbHome }),
    ...(options.eventLimits === undefined ? {} : { eventLimits: options.eventLimits }),
    ...(options.providerInstances === undefined ? {} : { providerInstances: options.providerInstances }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.watchConfig === undefined ? {} : { watchConfig: options.watchConfig }),
  };
  const state = await createServerState(stateOptions);
  const logger = options.logger ?? defaultLogger;
  const controller = createAutoUpdateController({
    isManagedService: options.autoUpdate?.isManagedService ?? (() => false),
    applyUpdate: options.autoUpdate?.applyUpdate,
    notifyAvailable: options.autoUpdate?.notifyAvailable,
    currentVersion: options.version ?? '0.0.0',
    fetchLatest: options.autoUpdate?.fetchLatest ?? fetchLatestNpmVersion,
    onError: (error) => {
      logServerEvent(logger, {
        event: 'auto_update.failed',
        error: error instanceof Error ? error.message : String(error),
        errorType: serverErrorType(error),
      });
    },
  });
  try {
    const routes = (options.__test?.createRoutes ?? createRoutes)(
      state,
      options.dashboardAssets,
      () => dashboardAuthAvailable,
      options.version,
      options.port ?? state.currentConfig().server.port,
      options.host ?? state.currentConfig().server.host,
      controller,
    );
    controller.start();
    let closed = false;
    return Object.assign(routes, {
      close() {
        if (closed) return;
        closed = true;
        controller.stop();
        state.close();
      },
    });
  } catch (error) {
    try {
      controller.stop();
    } catch {}
    try {
      state.close();
    } catch {}
    throw error;
  }
};
