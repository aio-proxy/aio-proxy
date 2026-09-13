import { canonicalizeLoopbackHost } from '@aio-proxy/core';
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
import type { AutoUpdateController } from '../auto-update';
import type { DashboardAssets } from '../dashboard-assets';
import {
  createDashboardAuthentication,
  createDashboardAuthRoutes,
  isDashboardLoopbackRequest,
  requireDashboardAuthentication,
} from '../dashboard-auth';
import { createDashboardRoutes } from '../dashboard-routes/config';
import { createAnthropicMessagesRoutes } from '../routes/anthropic-messages';
import { createGeminiGenerateContentRoutes } from '../routes/gemini-generate-content';
import { createGeminiInteractionsRoutes } from '../routes/gemini-interactions';
import { createOpenAIAudioRoutes } from '../routes/openai-audio';
import { createOpenAICompletionsRoutes } from '../routes/openai-completions';
import { createOpenAIEmbeddingsRoutes } from '../routes/openai-embeddings';
import { createOpenAIImagesRoutes } from '../routes/openai-images';
import { createOpenAIResponsesRoutes } from '../routes/openai-responses';
import { createRealtimeRoutes, type RealtimeRouteSource } from '../routes/realtime';
import { createOpenAIVideosRoutes, type VideosRouteSource } from '../routes/videos';
import type { ServerState } from '../server-state';
import { requireModelAuthentication, type AgentEnv } from './agent-auth';
import { authenticationError } from './api-key-auth/api-key-auth';
import { createDashboardArtifactRoutes } from './dashboard-artifacts';
import { serverDefaults } from './defaults';
import { agentCatalog, codexClientModels, listModels } from './list-models/index';

const csrfMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const canonicalLoopbackOriginHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

const loopbackOriginHostname = (host: string): string => {
  if (host === '::' || host === '[::]') return '[::1]';
  const canonical = canonicalizeLoopbackHost(host);
  if (canonical === undefined) return serverDefaults.host;
  return canonical === '::1' ? '[::1]' : canonical;
};

const hostHeaderHostname = (host: string): string | undefined => {
  try {
    // Host is authority-only; wrapping it in a scheme lets URL handle the bracketed IPv6 form.
    return new URL(`http://${host}`).hostname || undefined;
  } catch {
    return undefined;
  }
};

/**
 * DNS rebinding defence for the unauthenticated dashboard. An attacker page whose name resolves to
 * 127.0.0.1 arrives over a loopback socket and reports `sec-fetch-site: same-origin`, so neither the
 * peer address nor the fetch metadata can tell it apart from the real dashboard. Its `Host` header
 * still carries the attacker's name, and the real dashboard always addresses the server by its
 * loopback host, so that is the only signal separating them.
 *
 * Applies to every method, because the Origin/CSRF guard covers writes only and it is the
 * unauthenticated reads that disclose provider credentials. Only enforced while no dashboard
 * password is configured: a remote password-protected dashboard is a supported deployment addressed
 * by its own hostname, and there a rebound page is already stopped by the bearer check, since it
 * cannot read the real origin's token.
 *
 * A missing `Host` is allowed. Browsers always send it and cannot forge it, which is the entire
 * threat being closed here; a client that omits it is not a browser and could equally have sent the
 * expected value.
 */
const requireExpectedHost =
  (expectedHost: string): MiddlewareHandler =>
  async (context, next) => {
    const host = context.req.header('host');
    const hostname = host === undefined ? undefined : hostHeaderHostname(host);
    if (
      host !== undefined &&
      (hostname === undefined || (hostname !== expectedHost && !canonicalLoopbackOriginHosts.has(hostname)))
    ) {
      return context.text('Forbidden', 403);
    }
    await next();
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
  adminSameHostOrigin: MiddlewareHandler,
): void => {
  app.use('/admin/*', async (context, next) => {
    if (isDashboardLoopbackRequest(context)) {
      await next();
      return;
    }
    if (!dashboardAuthEnabled()) return context.notFound();
    return requireDashboardAuth(context, next);
  });
  app.use('/admin/*', adminSameHostOrigin);
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
    if (context.req.query('client_version') !== undefined) {
      if (grant !== undefined && grant.target !== 'codex') {
        return context.json({ error: { code: 'invalid_request', message: 'Invalid Agent catalog negotiation.' } }, 400);
      }
      return context.json(await codexClientModels(state, { signal: context.req.raw.signal }));
    }
    if (grant !== undefined && grant.target !== 'codex') {
      return context.json({ error: { code: 'invalid_request', message: 'Invalid Agent catalog negotiation.' } }, 400);
    }
    return context.json(await listModels(state));
  };

/** Narrows `ServerState` to what realtime is allowed to see: no usage capture, no
 *  request recorder, no cooldown store. */
const realtimeRouteSource = (state: ServerState): RealtimeRouteSource => ({
  acquireProviderSnapshot: state.acquireProviderSnapshot,
  logger: state.logger,
  realtimeCalls: state.realtimeCalls,
});

const videoRouteSource = (state: ServerState): VideosRouteSource => state;

export const createRoutes = (
  state: ServerState,
  dashboardAssets?: DashboardAssets,
  dashboardAuthAvailable: () => boolean = () => true,
  version: string = '0.0.0',
  loopbackPort: number = serverDefaults.port,
  loopbackHost: string = serverDefaults.host,
  controller?: AutoUpdateController,
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
  const expectedHost = requireExpectedHost(expectedLoopbackHost);
  const requireLoopbackHost: MiddlewareHandler = async (context, next) => {
    if (dashboardAuth.enabled()) {
      await next();
      return;
    }
    return expectedHost(context, next);
  };
  app.use('/admin/*', requireLoopbackHost);
  mountAdminControlPlane(
    app,
    state,
    requireDashboardAuth,
    dashboardAuth.enabled,
    requireAdminSameHostOrigin(expectedLoopbackHost, loopbackPort),
  );

  app.use('/dashboard', requireDashboardAccess);
  app.use('/dashboard/*', requireDashboardAccess);

  app.use('/dashboard/api/*', requireLoopbackHost);
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
  const dashboardRoutes = createDashboardRoutes(state, dashboardAuth, version, controller);
  const dashboardAuthRoutes = createDashboardAuthRoutes(dashboardAuth);
  const anthropicMessagesRoutes = createAnthropicMessagesRoutes(state);
  const geminiGenerateContentRoutes = createGeminiGenerateContentRoutes(state);
  const geminiInteractionsRoutes = createGeminiInteractionsRoutes(state);
  const openAICompletionsRoutes = createOpenAICompletionsRoutes(state);
  const openAIEmbeddingsRoutes = createOpenAIEmbeddingsRoutes(state);
  const openAIResponsesRoutes = createOpenAIResponsesRoutes(state);
  const openAIImagesRoutes = createOpenAIImagesRoutes(state);
  const openAIAudioRoutes = createOpenAIAudioRoutes(state);
  // Mounted (below) only after `app.use('/v1/*', modelAuthentication)`: a realtime route
  // registered ahead of that middleware reads every caller as the anonymous principal,
  // and the create/attach ownership check would then admit anyone.
  const realtimeRoutes = createRealtimeRoutes(realtimeRouteSource(state));
  const videoRoutes = createOpenAIVideosRoutes(videoRouteSource(state));
  const routes = app
    .route('/oauth', agentOAuthRoutes)
    .route('/dashboard/api/agent-authorizations', agentApprovalRoutes)
    .route('/admin/agent-installations', agentAdminRoutes)
    .route('/', anthropicMessagesRoutes)
    .route('/', geminiGenerateContentRoutes)
    .route('/', geminiInteractionsRoutes)
    .route('/', openAICompletionsRoutes)
    .route('/', openAIEmbeddingsRoutes)
    .route('/', openAIResponsesRoutes)
    .route('/', openAIImagesRoutes)
    .route('/', openAIAudioRoutes)
    .route('/', videoRoutes)
    .route('/', realtimeRoutes)
    .route('/dashboard/api/auth', dashboardAuthRoutes)
    .route('/dashboard/api', dashboardRoutes);

  if (dashboardAssets !== undefined) {
    routes.route('/dashboard', createDashboardArtifactRoutes(dashboardAssets));
  }

  return routes;
};
