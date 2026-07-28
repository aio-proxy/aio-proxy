import { parseRuntimeConfig } from '@aio-proxy/core';
import type { Context } from 'hono';
import { Hono } from 'hono';

import type { DashboardAssets } from '../dashboard-assets';
import {
  createDashboardAuthentication,
  createDashboardAuthRoutes,
  prepareDashboardConfig,
  requireDashboardAuthentication,
  requireDashboardLoopback,
} from '../dashboard-auth';
import type { DashboardEventLimits } from '../dashboard-events';
import { createDashboardRoutes } from '../dashboard-routes/config';
import { createAnthropicMessagesRoutes } from '../routes/anthropic-messages';
import { createGeminiGenerateContentRoutes } from '../routes/gemini-generate-content';
import { createOpenAICompletionsRoutes } from '../routes/openai-completions';
import { createOpenAIResponsesRoutes } from '../routes/openai-responses';
import type { RuntimeProviderInput } from '../runtime';
import type { ServerLogSink } from '../server-log';
import { logServerEvent, serverErrorType } from '../server-log';
import { createServerState, type ServerState } from '../server-state';
import { defaultLogger } from '../server-state/logging';
import type { InternalServerStateOptions } from '../server-state/types';
import { codexClientModels, listModels } from './list-models/index';

export const serverDefaults = {
  host: '127.0.0.1',
  port: 9_317,
} as const;

const dashboardOrigins = (port: number) =>
  new Set([`http://127.0.0.1:${port}`, `http://[::1]:${port}`, `http://localhost:${port}`]);

const csrfMethods = new Set(['POST', 'PUT', 'DELETE']);

export type CreateServerOptions = {
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
};

const createRoutes = (
  state: ServerState,
  dashboardOriginPort: number = serverDefaults.port,
  dashboardAssets?: DashboardAssets,
  dashboardAuthAvailable: () => boolean = () => true,
) => {
  const app = new Hono().get('/health', (context) =>
    context.json({
      status: 'ok',
      uptime: performance.now() / 1_000,
      version: '0.0.0',
    }),
  );
  app.get('/v1/models', async (context) => {
    if (context.req.query('client_version') !== undefined) {
      return context.json(await codexClientModels(state, { signal: context.req.raw.signal }));
    }
    return context.json(await listModels(state));
  });
  const allowedDashboardOrigins = dashboardOrigins(dashboardOriginPort);
  const dashboardAuth = createDashboardAuthentication(
    () => state.currentConfig().server.password,
    Date.now,
    dashboardAuthAvailable,
  );

  app.use('/dashboard', requireDashboardLoopback);
  app.use('/dashboard/*', requireDashboardLoopback);

  app.use('/dashboard/api/*', async (context, next) => {
    if (!csrfMethods.has(context.req.method)) {
      await next();
      return;
    }

    const origin = context.req.header('origin');
    if (origin === undefined || !allowedDashboardOrigins.has(origin)) {
      return context.text('Forbidden', 403);
    }

    await next();
  });

  const requireDashboardAuth = requireDashboardAuthentication(dashboardAuth);
  app.use('/dashboard/api/*', async (context, next) => {
    if (context.req.path.startsWith('/dashboard/api/auth/')) {
      await next();
      return;
    }
    return requireDashboardAuth(context, next);
  });

  const dashboardRoutes = createDashboardRoutes(state, dashboardAuth);
  const dashboardAuthRoutes = createDashboardAuthRoutes(dashboardAuth);
  const anthropicMessagesRoutes = createAnthropicMessagesRoutes(state);
  const geminiGenerateContentRoutes = createGeminiGenerateContentRoutes(state);
  const openAICompletionsRoutes = createOpenAICompletionsRoutes(state);
  const openAIResponsesRoutes = createOpenAIResponsesRoutes(state);
  const routes = app
    .route('/', anthropicMessagesRoutes)
    .route('/', geminiGenerateContentRoutes)
    .route('/', openAICompletionsRoutes)
    .route('/', openAIResponsesRoutes)
    .route('/dashboard/api/auth', dashboardAuthRoutes)
    .route('/dashboard/api', dashboardRoutes);

  if (dashboardAssets !== undefined) {
    const dashboardIndex = async (context: Context) => (await dashboardAssets('index.html')) ?? context.notFound();
    routes
      .get('/dashboard', dashboardIndex)
      .get('/dashboard/', dashboardIndex)
      .get(
        '/dashboard/static/*',
        async (context) =>
          (await dashboardAssets(context.req.path.replace(/^\/dashboard\//u, ''))) ?? context.notFound(),
      )
      .all('/dashboard/static/*', (context) => context.notFound())
      .all('/dashboard/api', (context) => context.notFound())
      .all('/dashboard/api/*', (context) => context.notFound())
      .get('/dashboard/*', dashboardIndex);
  }

  return routes;
};

export type AppType = ReturnType<typeof createRoutes>;

export const createServer = async (options: CreateServerOptions): Promise<AppType> => {
  const prepared = await prepareDashboardConfig(options.config, options.configPath);
  let dashboardAuthAvailable = !prepared.dashboardUnavailable;
  if (prepared.error !== undefined) {
    logServerEvent(options.logger ?? defaultLogger, {
      error: prepared.error instanceof Error ? prepared.error.message : String(prepared.error),
      errorType: serverErrorType(prepared.error),
      event: 'dashboard.auth_unavailable',
    });
  }
  const config = parseRuntimeConfig(prepared.config);
  const stateOptions: InternalServerStateOptions = {
    config,
    __dashboardAuthHealthChanged: (available) => {
      dashboardAuthAvailable = available;
    },
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.dbHome === undefined ? {} : { dbHome: options.dbHome }),
    ...(options.eventLimits === undefined ? {} : { eventLimits: options.eventLimits }),
    ...(options.providerInstances === undefined ? {} : { providerInstances: options.providerInstances }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.watchConfig === undefined ? {} : { watchConfig: options.watchConfig }),
  };
  return createRoutes(
    await createServerState(stateOptions),
    options.port ?? config.server.port,
    options.dashboardAssets,
    () => dashboardAuthAvailable,
  );
};
