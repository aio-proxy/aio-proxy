import type { AgentIdentityService } from '@aio-proxy/core';
import {
  AGENT_CLIENT_ID,
  AgentAuthorizationResolveRequestSchema,
  AgentDeviceCodeRequestSchema,
  AgentTokenRequestSchema,
  type AgentOAuthError,
  type Config,
} from '@aio-proxy/types';
import { type Context, type MiddlewareHandler, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { validator } from 'hono/validator';
import { type ZodType, z } from 'zod';

import { requireDashboardLoopback } from '../dashboard-auth';
import { DeviceChallengeError, type DeviceChallengeStore } from './device-challenges';

type AgentOAuthRouteInput = {
  readonly challenges: DeviceChallengeStore;
  readonly identity: AgentIdentityService;
  readonly currentConfig: () => Config;
};
type AgentApprovalRouteInput = Pick<AgentOAuthRouteInput, 'challenges' | 'currentConfig'>;
type AgentAdminRouteInput = Pick<AgentOAuthRouteInput, 'identity' | 'currentConfig'>;

const requestPeer = (context: Context): string => {
  const env = context.env as { requestIP?: (request: Request) => { address: string } | null } | undefined;
  const address = env?.requestIP?.(context.req.raw)?.address;
  if (address === undefined) throw new Error('loopback middleware admitted a request without a transport peer');
  return address;
};
const noStore = (context: Context): void => context.header('cache-control', 'no-store');
const oauthError = (context: Context, status: ContentfulStatusCode, error: AgentOAuthError['error']) => {
  noStore(context);
  return context.json({ error }, status);
};
const formValidator = <T>(schema: ZodType<T>) =>
  validator('form', (raw, context) => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : oauthError(context, 400, 'invalid_request');
  });
const resolveValidator = validator('json', (raw, context) => {
  const parsed = AgentAuthorizationResolveRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'invalid_request' }, 400);
});
const challengeError = (context: Context, error: unknown) => {
  if (error instanceof DeviceChallengeError) {
    noStore(context);
    return context.json({ error: error.code }, error.status);
  }
  throw error;
};

export const createAgentOAuthRoutes = ({ challenges, identity, currentConfig }: AgentOAuthRouteInput) =>
  new Hono()
    .use('*', requireDashboardLoopback)
    .post('/device/code', formValidator(AgentDeviceCodeRequestSchema), (context) => {
      const body = context.req.valid('form');
      if (AGENT_CLIENT_ID[body.agent] !== body.client_id) return oauthError(context, 400, 'invalid_client');
      const server = currentConfig().server;
      if (server.apiKeys.length > 0 && server.password === undefined)
        return oauthError(context, 503, 'authorization_unavailable');
      try {
        const response = challenges.create(body, requestPeer(context));
        noStore(context);
        return context.json(response);
      } catch (error) {
        return challengeError(context, error);
      }
    })
    .post('/token', formValidator(AgentTokenRequestSchema), (context) => {
      const body = context.req.valid('form');
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
        const result = challenges.poll(
          { clientId: body.client_id, deviceCode: body.device_code },
          requestPeer(context),
        );
        if (!result.ok) {
          if (result.interval !== undefined) context.header('retry-after', String(result.interval));
          return oauthError(context, 400, result.error);
        }
        noStore(context);
        return context.json(result.token);
      }
      const result = identity.refreshCredential({ clientId: body.client_id, refreshToken: body.refresh_token });
      if (result.status !== 'success') return oauthError(context, 400, 'invalid_grant');
      noStore(context);
      return context.json({
        token_type: 'Bearer' as const,
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_in: result.expiresIn,
      });
    });

const requireAgentApprovalOrigin: MiddlewareHandler = async (context, next) => {
  const origin = context.req.header('origin');
  const fetchSite = context.req.header('sec-fetch-site');
  if (
    origin !== new URL(context.req.url).origin ||
    (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none')
  )
    return context.json({ error: 'forbidden' }, 403);
  await next();
};

export const createAgentApprovalRoutes = ({ challenges, currentConfig }: AgentApprovalRouteInput) =>
  new Hono()
    .use('*', requireAgentApprovalOrigin)
    .use('*', async (context, next) => {
      const server = currentConfig().server;
      if (server.apiKeys.length > 0 && server.password === undefined)
        return context.json({ error: 'authorization_unavailable' }, 503);
      await next();
    })
    .post('/resolve', resolveValidator, (context) => {
      try {
        return context.json(challenges.resolve(context.req.valid('json').userCode, requestPeer(context)));
      } catch (error) {
        return challengeError(context, error);
      }
    })
    .post('/:deviceId/approve', (context) => {
      try {
        return context.json({ status: challenges.approve(context.req.param('deviceId'), requestPeer(context)) });
      } catch (error) {
        return challengeError(context, error);
      }
    })
    .post('/:deviceId/deny', (context) => {
      try {
        return context.json({ status: challenges.deny(context.req.param('deviceId'), requestPeer(context)) });
      } catch (error) {
        return challengeError(context, error);
      }
    });

export const createAgentAdminRoutes = ({ identity, currentConfig }: AgentAdminRouteInput) =>
  new Hono()
    .use('*', requireDashboardLoopback)
    .get('/', (context) =>
      context.json({
        installations: identity.listInstallations(),
        deviceAuthorization:
          currentConfig().server.apiKeys.length > 0 && currentConfig().server.password === undefined
            ? ('password_required' as const)
            : ('available' as const),
        catalogSchemaVersions: [1] as const,
      }),
    )
    .post('/:installationId/revoke', (context) => {
      const installationId = context.req.param('installationId');
      if (!z.string().uuid().safeParse(installationId).success) return context.json({ error: 'invalid_request' }, 400);
      return context.json({ installationId, status: identity.revokeInstallation(installationId) });
    });
