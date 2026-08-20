import { parseRuntimeConfig } from '@aio-proxy/core';
import { currentRequestId, withRequestId } from '@aio-proxy/logger';
import { AgentCatalogQuerySchema } from '@aio-proxy/types';
import { honoLogger } from '@logtape/hono';
import type { Context, MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { bearerAuth } from 'hono/bearer-auth';

import {
  createAgentAdminRoutes,
  createAgentApprovalRoutes,
  createAgentOAuthRoutes,
  createDeviceChallengeStore,
} from '../agent-authorization';
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
import type { InternalServerStateOptions, ServerStateTestHooks } from '../server-state/types';
import { requireModelAuthentication, type AgentEnv } from './agent-auth';
import { authenticationError } from './api-key-auth/api-key-auth';
import { agentCatalog, codexClientModels, listModels } from './list-models/index';

export const serverDefaults = {
  host: '127.0.0.1',
  port: 9_317,
} as const;

const csrfMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const canonicalLoopbackOriginHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

const loopbackOriginHostname = (host: string): string => {
  if (host === 'localhost' || host.startsWith('127.')) return host;
  return host === '::1' ? '[::1]' : serverDefaults.host;
};

const hasLoopbackOrigin = (context: Context, expectedHost: string, expectedPort: number): boolean => {
  const origin = context.req.header('origin');
  if (origin === undefined) return false;
  try {
    const { hostname, port, protocol } = new URL(origin);
    const originPort = port === '' ? (protocol === 'https:' ? 443 : 80) : Number(port);
    return (
      (protocol === 'http:' || protocol === 'https:') &&
      originPort === expectedPort &&
      (hostname === expectedHost || canonicalLoopbackOriginHosts.has(hostname))
    );
  } catch {
    return false;
  }
};

const requireSameHostOrigin =
  (expectedHost: string, expectedPort: number): MiddlewareHandler =>
  async (context, next) => {
    if (!csrfMethods.has(context.req.method)) {
      await next();
      return;
    }
    const origin = context.req.header('origin');
    if (origin === undefined || !hasLoopbackOrigin(context, expectedHost, expectedPort)) {
      return context.text('Forbidden', 403);
    }
    const fetchSite = context.req.header('sec-fetch-site');
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return context.text('Forbidden', 403);
    }
    await next();
  };

const requireAdminSameHostOrigin =
  (expectedHost: string, expectedPort: number): MiddlewareHandler =>
  async (context, next) => {
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
    return requireSameHostOrigin(expectedHost, expectedPort)(context, next);
  };

const mountAdminControlPlane = (
  app: Hono,
  state: ServerState,
  requireDashboardAuth: ReturnType<typeof requireDashboardAuthentication>,
  dashboardAuthEnabled: () => boolean,
  requireAdminSameHostOrigin: MiddlewareHandler,
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

type AgentCatalogQuery = ReturnType<typeof AgentCatalogQuerySchema.parse>;
type ModelsEnv = {
  Variables: AgentEnv['Variables'] & {
    agentCatalogQuery: AgentCatalogQuery | null;
  };
};

const agentQueryFields = ['agent', 'adapter_version', 'schema_version'] as const;

const parseAgentCatalogNegotiation: MiddlewareHandler<ModelsEnv> = async (context, next) => {
  const raw = Object.fromEntries(
    agentQueryFields.flatMap((field) => {
      const value = context.req.query(field);
      return value === undefined ? [] : ([[field, value]] as const);
    }),
  );
  if (Object.keys(raw).length === 0) {
    context.set('agentCatalogQuery', null);
    await next();
    return;
  }
  if (raw['schema_version'] !== undefined && raw['schema_version'] !== '1') {
    return context.json(
      {
        error: {
          code: 'unsupported_schema',
          message: `Agent catalog schema ${raw['schema_version']} is not supported.`,
        },
        supported_schema_versions: [1],
      },
      400,
    );
  }
  const parsed = AgentCatalogQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return context.json({ error: { code: 'invalid_request', message: 'Invalid Agent catalog negotiation.' } }, 400);
  }
  context.set('agentCatalogQuery', parsed.data);
  await next();
};

const listModelsHandler =
  (state: ServerState): MiddlewareHandler<ModelsEnv> =>
  async (context) => {
    const query = context.get('agentCatalogQuery');
    const grant = context.get('agentGrant');
    if (query !== null && query !== undefined) {
      if (grant === undefined) return authenticationError(context);
      if (grant.target !== query.agent) {
        return context.json({ error: { code: 'forbidden', message: 'Agent catalog target mismatch.' } }, 403);
      }
      return context.json(await agentCatalog(state, query.agent));
    }
    if (grant !== undefined) {
      return context.json({ error: { code: 'invalid_request', message: 'Invalid Agent catalog negotiation.' } }, 400);
    }
    if (context.req.query('client_version') !== undefined) {
      return context.json(await codexClientModels(state, { signal: context.req.raw.signal }));
    }
    return context.json(await listModels(state));
  };

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
};

const createRoutes = (
  state: ServerState,
  dashboardAssets?: DashboardAssets,
  dashboardAuthAvailable: () => boolean = () => true,
  version: string = '0.0.0',
  loopbackPort: number = serverDefaults.port,
  loopbackHost: string = serverDefaults.host,
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
        context.req.path.startsWith('/dashboard/') ||
        context.req.path === '/oauth/device/code' ||
        context.req.path === '/oauth/token',
    }),
  );
  const modelAuthentication = requireModelAuthentication({
    apiKeys: () => state.currentConfig().server.apiKeys,
    authenticateAgent: (token) => state.agentIdentity.authenticateAccessToken(token),
  });
  app.get('/v1/models', parseAgentCatalogNegotiation, modelAuthentication, listModelsHandler(state));
  app.use('/v1/*', modelAuthentication);
  app.use('/v1beta/*', modelAuthentication);
  app.get('/health', (context) =>
    context.json({
      status: 'ok',
      uptime: performance.now() / 1_000,
      version,
    }),
  );
  const dashboardAuth = createDashboardAuthentication(
    () => state.currentConfig().server.password,
    Date.now,
    dashboardAuthAvailable,
  );
  const requireDashboardAuth = requireDashboardAuthentication(dashboardAuth);
  const requireDashboardBearerAuth = bearerAuth({ verifyToken: (token) => dashboardAuth.verify(token) });
  const expectedLoopbackHost = loopbackOriginHostname(loopbackHost);
  const requireLoopbackSameOrigin = requireSameHostOrigin(expectedLoopbackHost, loopbackPort);
  const requireDashboardAccess = async (context: Context, next: () => Promise<void>) => {
    if (isDashboardLoopbackRequest(context) || dashboardAuth.enabled()) {
      await next();
      return;
    }
    return context.notFound();
  };
  mountAdminControlPlane(
    app,
    state,
    requireDashboardAuth,
    dashboardAuth.enabled,
    requireAdminSameHostOrigin(expectedLoopbackHost, loopbackPort),
  );

  app.use('/dashboard', requireDashboardAccess);
  app.use('/dashboard/*', requireDashboardAccess);

  app.use('/dashboard/api/*', async (context, next) => {
    if (dashboardAuth.enabled()) {
      await next();
      return;
    }
    return requireLoopbackSameOrigin(context, next);
  });

  app.use('/dashboard/api/*', async (context, next) => {
    if (context.req.path.startsWith('/dashboard/api/auth/')) {
      await next();
      return;
    }
    if (dashboardAuth.enabled()) {
      if (!dashboardAuth.available()) return context.json({ error: 'dashboard_unavailable' }, 503);
      return requireDashboardBearerAuth(context, next);
    }
    return requireDashboardAuth(context, next);
  });

  const approvalOrigin = `http://${expectedLoopbackHost}:${loopbackPort}`;
  const challenges = createDeviceChallengeStore({
    identity: state.agentIdentity,
    verificationUri: new URL('/dashboard/agents/authorize', approvalOrigin).href,
  });
  const currentConfig = () => state.currentConfig();
  const agentOAuthRoutes = createAgentOAuthRoutes({ challenges, identity: state.agentIdentity, currentConfig });
  const agentApprovalRoutes = createAgentApprovalRoutes({ challenges, currentConfig });
  const agentAdminRoutes = createAgentAdminRoutes({ identity: state.agentIdentity, currentConfig });
  const dashboardRoutes = createDashboardRoutes(state, dashboardAuth);
  const dashboardAuthRoutes = createDashboardAuthRoutes(dashboardAuth);
  const anthropicMessagesRoutes = createAnthropicMessagesRoutes(state);
  const geminiGenerateContentRoutes = createGeminiGenerateContentRoutes(state);
  const openAICompletionsRoutes = createOpenAICompletionsRoutes(state);
  const openAIResponsesRoutes = createOpenAIResponsesRoutes(state);
  const routes = app
    .route('/oauth', agentOAuthRoutes)
    .route('/dashboard/api/agent-authorizations', agentApprovalRoutes)
    .route('/admin/agent-installations', agentAdminRoutes)
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

export type AppType = ReturnType<typeof createRoutes> & { readonly close: () => void };

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
    ...(options.__test === undefined ? {} : { __test: options.__test }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.dbHome === undefined ? {} : { dbHome: options.dbHome }),
    ...(options.eventLimits === undefined ? {} : { eventLimits: options.eventLimits }),
    ...(options.providerInstances === undefined ? {} : { providerInstances: options.providerInstances }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.watchConfig === undefined ? {} : { watchConfig: options.watchConfig }),
  };
  const state = await createServerState(stateOptions);
  try {
    const routes = (options.__test?.createRoutes ?? createRoutes)(
      state,
      options.dashboardAssets,
      () => dashboardAuthAvailable,
      options.version,
      options.port ?? state.currentConfig().server.port,
      options.host ?? state.currentConfig().server.host,
    );
    let closed = false;
    return Object.assign(routes, {
      close() {
        if (closed) return;
        closed = true;
        state.close();
      },
    });
  } catch (error) {
    try {
      state.close();
    } catch {}
    throw error;
  }
};
