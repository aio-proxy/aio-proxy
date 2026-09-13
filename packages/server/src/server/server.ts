import { fetchLatestNpmVersion, parseRuntimeConfig } from '@aio-proxy/core';

import { createAutoUpdateController } from '../auto-update';
import { warnLeftoverOAuthModels } from '../config-leftover-oauth-models';
import { prepareDashboardConfig } from '../dashboard-auth';
import { logServerEvent, serverErrorType } from '../server-log';
import { createServerState } from '../server-state';
import { defaultLogger } from '../server-state/logging';
import type { ServerStateTestHooks } from '../server-state/types';
import { createRoutes } from './create-routes';
import { serverDefaults } from './defaults';
import { createServerStateOptions, type ServerOptionsBase } from './server-options';

/** The Bun WebSocket handler the realtime routes' `upgradeWebSocket` needs at the
 *  `Bun.serve` call site. `createServer` returns `Object.assign(routes, { close })`, so this
 *  cannot ride on the app object and has to be a module-level export. Hono exports it as a
 *  module singleton shared by every importer, so a call site must spread it, never mutate it. */
export { websocket } from 'hono/bun';

export { serverDefaults };

export type CreateServerOptions = ServerOptionsBase & {
  readonly __test?: ServerStateTestHooks & { readonly createRoutes?: typeof createRoutes };
};

export type AppType = ReturnType<typeof createRoutes>;

export const createServer = async (
  options: CreateServerOptions,
): Promise<AppType & { readonly close: () => void; readonly closeAsync: () => Promise<void> }> => {
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
  const stateOptions = createServerStateOptions({
    config,
    configPath: options.configPath,
    dbHome: options.dbHome,
    eventLimits: options.eventLimits,
    providerInstances: options.providerInstances,
    logger: options.logger,
    watchConfig: options.watchConfig,
    builtIns: options.builtIns,
    testHooks: options.__test,
    dashboardAuthHealthChanged: (available) => {
      dashboardAuthAvailable = available;
    },
  });
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
      async closeAsync() {
        if (closed) return;
        closed = true;
        controller.stop();
        await state.closeAsync();
      },
    });
  } catch (error) {
    try {
      controller.stop();
    } catch {}
    try {
      await state.closeAsync();
    } catch {}
    throw error;
  }
};
