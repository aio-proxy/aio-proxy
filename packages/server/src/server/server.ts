import { parseRuntimeConfig } from '@aio-proxy/core';
import { currentRequestId, withRequestId } from '@aio-proxy/logger';
import { honoLogger } from '@logtape/hono';
import type { Context } from 'hono';
import { Hono } from 'hono';

import type { DashboardAssets } from '../dashboard-assets';
import {
  createDashboardAuthentication,
  createDashboardAuthRoutes,
  isDashboardLoopbackRequest,
  prepareDashboardConfig,
  requireDashboardAuthentication,
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
import { requireApiKey } from './api-key-auth';
import { codexClientModels, listModels } from './list-models/index';

export const serverDefaults = {
  host: '127.0.0.1',
  port: 9_317,
} as const;

const csrfMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const hasSameHostOrigin = (context: Context): boolean => {
  const origin = context.req.header('origin');
  const host = context.req.header('host') ?? new URL(context.req.url).host;
  if (origin === undefined) return false;
  try {
    return new URL(origin).host === new URL(`http://${host}`).host;
  } catch {
    return false;
  }
};

const requireSameHostOrigin = async (context: Context, next: () => Promise<void>) => {
  if (!csrfMethods.has(context.req.method)) {
    await next();
    return;
  }
  const origin = context.req.header('origin');
  if (origin === undefined || !hasSameHostOrigin(context)) {
    return context.text('Forbidden', 403);
  }
  const fetchSite = context.req.header('sec-fetch-site');
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return context.text('Forbidden', 403);
  }
  await next();
};

const requireAdminSameHostOrigin = async (context: Context, next: () => Promise<void>) => {
  if (
    csrfMethods.has(context.req.method) &&
    context.req.header('origin') === undefined &&
    isDashboardLoopbackRequest(context)
  ) {
    const fetchSite = context.req.header('sec-fetch-site');
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return context.text('Forbidden', 403);
    }
    await next();
    return;
  }
  return requireSameHostOrigin(context, next);
};

const mountAdminControlPlane = (
  app: Hono,
  state: ServerState,
  requireDashboardAuth: ReturnType<typeof requireDashboardAuthentication>,
  dashboardAuthEnabled: () => boolean,
): void => {
  app.use('/admin/*', async (context, next) => {
    if (isDashboardLoopbackRequest(context)) {
      await next();
      return;
    }
    if (!dashboardAuthEnabled()) return context.notFound();
    return requireDashboardAuth(context, next);
  });
  app.use('/admin/*', requireAdminSameHostOrigin);
  app.post('/admin/reload', async (context) => {
    const result = await state.reload();
    return result.ok
      ? context.json({ ok: true, diff: result.diff })
      : context.json({ ok: false, error: result.error, stage: result.stage }, 409);
  });
};

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
  readonly version?: string;
};

const createRoutes = (
  state: ServerState,
  dashboardAssets?: DashboardAssets,
  dashboardAuthAvailable: () => boolean = () => true,
  version: string = '0.0.0',
) => {
  const app = new Hono();
  app.use((_context, next) => withRequestId(crypto.randomUUID(), next));
  app.use(
    honoLogger({
      category: ['aio-proxy', 'server', 'http'],
      level: 'info',
      format: 'structured-combined',
      context: {
        requestId: {
          headerNames: [],
          responseHeader: false,
          generate: () => currentRequestId() ?? crypto.randomUUID(),
        },
        include: ['requestId'],
      },
      skip: (context) =>
        context.req.path === '/health' ||
        context.req.path === '/dashboard' ||
        context.req.path.startsWith('/dashboard/'),
    }),
  );
  app.use(
    '/v1/*',
    requireApiKey(() => state.currentConfig().server.apiKeys),
  );
  app.get('/health', (context) =>
    context.json({
      status: 'ok',
      uptime: performance.now() / 1_000,
      version,
    }),
  );
  app.get('/v1/models', async (context) => {
    if (context.req.query('client_version') !== undefined) {
      return context.json(await codexClientModels(state, { signal: context.req.raw.signal }));
    }
    return context.json(await listModels(state));
  });
  const dashboardAuth = createDashboardAuthentication(
    () => state.currentConfig().server.password,
    Date.now,
    dashboardAuthAvailable,
  );
  const requireDashboardAuth = requireDashboardAuthentication(dashboardAuth);
  const requireDashboardAccess = async (context: Context, next: () => Promise<void>) => {
    if (isDashboardLoopbackRequest(context) || dashboardAuth.enabled()) {
      await next();
      return;
    }
    return context.notFound();
  };
  mountAdminControlPlane(app, state, requireDashboardAuth, dashboardAuth.enabled);

  app.use('/dashboard', requireDashboardAccess);
  app.use('/dashboard/*', requireDashboardAccess);

  app.use('/dashboard/api/*', requireSameHostOrigin);

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
      .get('/dashboard/static/*', async (context) => {
        const asset = await dashboardAssets(context.req.path.replace(/^\/dashboard\//u, ''));
        if (asset === null || asset === undefined) return context.notFound();
        asset.headers.set('cache-control', 'public, max-age=31536000, immutable');
        return asset;
      })
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
    const error: unknown = prepared.error;
    logServerEvent(options.logger ?? defaultLogger, {
      error: error instanceof Error ? error.message : String(error),
      errorType: serverErrorType(error),
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
    options.dashboardAssets,
    () => dashboardAuthAvailable,
    options.version,
  );
};
