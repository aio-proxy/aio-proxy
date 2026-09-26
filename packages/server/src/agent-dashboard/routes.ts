import type { AgentIdentityService } from '@aio-proxy/core';
import {
  AgentOperationRequestSchema,
  type AgentLocalSetup,
  type AgentLocalState,
  type AgentsSnapshot,
  type Config,
} from '@aio-proxy/types';
import { type Context, type MiddlewareHandler, Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

import {
  DeviceChallengeError,
  requestPeer,
  requireAgentApprovalOrigin,
  type DeviceChallengeStore,
} from '../agent-authorization';
import { isDashboardLoopbackRequest } from '../dashboard-auth';
import { logServerEvent, serverErrorType, type ServerLogSink } from '../server-log';
import { AgentOperationError, type AgentHostPort, type AgentOperationEvents } from './host-port';
import { AgentOperationBusyError, createAgentOperations } from './operations';

type AgentDashboardRouteInput = {
  readonly host: AgentHostPort | undefined;
  readonly identity: Pick<AgentIdentityService, 'listInstallations' | 'revokeInstallation'>;
  readonly challenges: DeviceChallengeStore;
  readonly currentConfig: () => Config;
  readonly logger: ServerLogSink;
  readonly adapterVersion: string;
};

const CHALLENGE_SOURCE = 'agent-dashboard';
const uuidParam = z.uuid();

const localSetup = (host: AgentHostPort | undefined, context: Context): AgentLocalSetup => {
  if (host === undefined) return 'unavailable';
  return isDashboardLoopbackRequest(context) ? 'available' : 'remote_request';
};

const requestValidator = validator('json', (raw, context) => {
  const parsed = AgentOperationRequestSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'invalid_request' as const }, 400);
});

export const createAgentDashboardRoutes = (input: AgentDashboardRouteInput) => {
  const { host, identity, challenges, currentConfig, logger } = input;
  const requireLocalHost: MiddlewareHandler = async (context, next) => {
    if (localSetup(host, context) !== 'available') return context.json({ error: 'local_setup_unavailable' }, 404);
    await next();
  };
  const requireLocalWrite: MiddlewareHandler = async (context, next) => {
    if (!isDashboardLoopbackRequest(context)) return context.json({ error: 'local_setup_unavailable' }, 404);
    return requireAgentApprovalOrigin(context, next);
  };
  const operations = createAgentOperations({
    run: (request, events: AgentOperationEvents) => {
      if (host === undefined) throw new AgentOperationError('unknown');
      if (request.kind === 'configure') return host.configure(request.target, request.codex, events);
      if (request.kind === 'remove') return host.remove(request.target, events);
      return host.restoreCodexMigration(request.operationId, events);
    },
    resolveDevice: (target, userCode) => {
      const details = challenges.resolve(userCode, CHALLENGE_SOURCE);
      if (details.status !== 'pending' || details.target !== target) return undefined;
      return {
        deviceId: details.deviceId,
        installationId: details.installationId,
        userCode,
        expiresAt: details.expiresAt,
      };
    },
    onUnknownError: (request, error) =>
      logServerEvent(logger, {
        event: 'agent.operation_failed',
        target: request.target,
        kind: request.kind,
        error: error instanceof Error ? error.message : String(error),
        errorType: serverErrorType(error),
      }),
  });
  const inspectLocal = async (): Promise<readonly AgentLocalState[] | undefined> => {
    try {
      return await host?.inspect();
    } catch (error) {
      logServerEvent(logger, {
        event: 'agent.operation_failed',
        target: 'all',
        kind: 'inspect',
        error: error instanceof Error ? error.message : String(error),
        errorType: serverErrorType(error),
      });
      return undefined;
    }
  };
  // Cancel also denies the challenge so the Agent side cannot redeem it after the dashboard gave up.
  const decide = (context: Context, operationId: string, decision: 'approve' | 'deny' | 'cancel') => {
    const deviceId = operations.device(operationId);
    if (deviceId === undefined) return context.json({ error: 'not_awaiting_approval' as const }, 409);
    try {
      const status = challenges[decision === 'approve' ? 'approve' : 'deny'](deviceId, requestPeer(context));
      const state =
        decision === 'approve' && status === 'approved'
          ? operations.resume(operationId)
          : operations.stop(operationId, decision === 'cancel' ? 'cancelled' : 'denied');
      return context.json(state!);
    } catch (error) {
      if (error instanceof DeviceChallengeError) return context.json({ error: error.code }, error.status);
      throw error;
    }
  };

  return new Hono()
    .get('/', async (context) => {
      const server = currentConfig().server;
      const setup = localSetup(host, context);
      const local = setup === 'available' ? await inspectLocal() : undefined;
      const snapshot: AgentsSnapshot = {
        localSetup: setup,
        deviceAuthorization: server.requireApiKey && server.password === undefined ? 'password_required' : 'available',
        adapterVersion: input.adapterVersion,
        installations: [...identity.listInstallations()],
        ...(local === undefined ? {} : { local: [...local] }),
      };
      return context.json(snapshot);
    })
    .post('/:installationId/revoke', requireLocalWrite, (context) => {
      const installationId = context.req.param('installationId');
      if (!uuidParam.safeParse(installationId).success) return context.json({ error: 'invalid_request' as const }, 400);
      return context.json({ installationId, status: identity.revokeInstallation(installationId) });
    })
    .get('/installations/:installationId/pending', requireLocalHost, async (context) => {
      const installationId = context.req.param('installationId');
      const local = (await inspectLocal())?.find((item) => item.installationId === installationId);
      if (local === undefined) return context.json({ error: 'unknown_installation' as const }, 404);
      return context.json({ authorization: challenges.pendingForInstallation(local.target, installationId) ?? null });
    })
    .get('/codex/plan', requireLocalHost, async (context) => {
      try {
        return context.json(await host!.codexPlan());
      } catch (error) {
        if (error instanceof AgentOperationError) return context.json({ error: error.code }, 409);
        throw error;
      }
    })
    .post('/operations', requireLocalHost, requireAgentApprovalOrigin, requestValidator, (context) => {
      try {
        return context.json(operations.start(context.req.valid('json')), 202);
      } catch (error) {
        if (error instanceof AgentOperationBusyError)
          return context.json({ error: 'operation_in_progress' as const }, 409);
        throw error;
      }
    })
    .get('/operations/:operationId', requireLocalHost, (context) => {
      const state = operations.get(context.req.param('operationId'));
      return state === undefined ? context.json({ error: 'not_found' as const }, 404) : context.json(state);
    })
    .post('/operations/:operationId/approve', requireLocalHost, requireAgentApprovalOrigin, (context) =>
      decide(context, context.req.param('operationId'), 'approve'),
    )
    .post('/operations/:operationId/deny', requireLocalHost, requireAgentApprovalOrigin, (context) =>
      decide(context, context.req.param('operationId'), 'deny'),
    )
    .post('/operations/:operationId/cancel', requireLocalHost, requireAgentApprovalOrigin, (context) =>
      decide(context, context.req.param('operationId'), 'cancel'),
    );
};
