import { type ModelsDevCapabilities, type ModelsDevCatalog, parseRuntimeConfig } from '@aio-proxy/core';
import type { ModelInfo as AnthropicModelInfo } from '@anthropic-ai/sdk/resources/models';
import { getUnixTime, isValid, parseISO } from 'date-fns';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { Model as OpenAIModel } from 'openai/resources/models';

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
import { resolveEnabledModels } from './model-resolution/index';

export const serverDefaults = {
  host: '127.0.0.1',
  port: 22_078,
} as const;

const dashboardOrigins = (port: number) =>
  new Set([`http://127.0.0.1:${port}`, `http://[::1]:${port}`, `http://localhost:${port}`]);

const csrfMethods = new Set(['POST', 'PUT', 'DELETE']);

export type CreateServerOptions = {
  readonly config: unknown;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly modelsDevCatalogTask?: () => Promise<ModelsDevCatalog | undefined>;
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
  app.get('/v1/models', async (context) => context.json(await listModels(state)));
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

const unknownCreatedAt = '1970-01-01T00:00:00Z';
type ModelListItem = OpenAIModel &
  Omit<AnthropicModelInfo, 'capabilities'> & {
    readonly capabilities: ModelsDevCapabilities | null;
  };

async function listModels(state: ServerState) {
  const resolved = await resolveEnabledModels(state);
  const data = resolved.map(({ slug, provider, metadata, displayName }): ModelListItem => {
    const timestamps = modelTimestamps(metadata?.releaseDate);
    return {
      capabilities: metadata?.capabilities ?? null,
      created: timestamps.created,
      created_at: timestamps.createdAt,
      display_name: displayName,
      id: slug,
      max_input_tokens: metadata?.maxInputTokens ?? null,
      max_tokens: metadata?.maxTokens ?? null,
      object: 'model',
      owned_by: provider.id,
      type: 'model',
    };
  });
  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
    object: 'list' as const,
  };
}

function modelTimestamps(releaseDate: string | undefined): { readonly created: number; readonly createdAt: string } {
  if (releaseDate === undefined) {
    return { created: 0, createdAt: unknownCreatedAt };
  }
  const normalizedDate = releaseDate.length === 7 ? `${releaseDate}-01` : releaseDate;
  const date = parseISO(`${normalizedDate}T00:00:00Z`);
  if (!isValid(date)) {
    return { created: 0, createdAt: unknownCreatedAt };
  }
  return { created: getUnixTime(date), createdAt: date.toISOString() };
}

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
    ...(options.modelsDevCatalogTask === undefined ? {} : { modelsDevCatalogTask: options.modelsDevCatalogTask }),
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
