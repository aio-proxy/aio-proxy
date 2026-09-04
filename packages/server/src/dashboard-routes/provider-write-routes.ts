import {
  AccountCleanupPendingError,
  NpmInstallError,
  NpmLockError,
  NpmPackageEntrypointError,
  NpmPackageJsonError,
  NpmPackageNameError,
  npmAdd,
  PendingAccountOperationConflictError,
} from '@aio-proxy/core';
import {
  type DashboardProviderRoutingMutation,
  DashboardProviderRoutingMutationSchema,
  type ProviderMutationBody,
} from '@aio-proxy/types';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { ZodError, z } from 'zod';

import { ConfigReloadRejectedError } from '../config-store';
import { isTrustedProviderPackage } from '../provider-package-trust';
import type { ServerState } from '../server-state';
import { createDashboardProviderEnableRoute } from './provider-enable';
import {
  insertProvider,
  type ParsedProviderMutation,
  parseProviderMutation,
  ProviderAlreadyExistsError,
  ProviderNotFoundError,
  replaceOAuthProvider,
  replaceProvider,
} from './provider-mutation';
import {
  applyProviderRoutingMutation,
  ProviderRoutingSetChangedError,
  providerRoutingRevision,
  ProviderRoutingStaleRevisionError,
} from './provider-routing-mutation';

const ProviderInstallRequestSchema = z.object({
  npm: z.string().min(1),
  confirmed: z.boolean().optional(),
  registry: z.url().optional(),
});

const providerMutationValidator = validator(
  'json',
  (raw: ProviderMutationBody, context): ParsedProviderMutation | Response => {
    const parsed = parseProviderMutation(raw);
    return parsed.ok ? parsed.body : context.json(parsed.payload, parsed.status);
  },
) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  { in: { json: ProviderMutationBody }; out: { json: ParsedProviderMutation } }
>;

const providerRoutingMutationValidator = validator('json', (raw, context) => {
  const parsed = DashboardProviderRoutingMutationSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'validation_failed' } as const, 400);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  { in: { json: DashboardProviderRoutingMutation }; out: { json: DashboardProviderRoutingMutation } }
>;

export const createDashboardProviderWriteRoutes = (state: ServerState) =>
  new Hono()
    .post('/providers', providerMutationValidator, async (context) => {
      if (state.configPath === undefined) {
        return context.json({ error: 'config file path is not configured' }, 409);
      }
      const { authored, materialized } = context.req.valid('json');
      if (materialized.kind === 'oauth') {
        return context.json({ error: 'OAuth providers must be created through login' }, 400);
      }
      const { id, ...bodyRest } = authored;
      if ('proxy' in bodyRest && bodyRest.proxy === null) delete bodyRest.proxy;
      const providerData: Record<string, unknown> = { ...bodyRest };
      try {
        await state.configStore.mutateProviders((record) => insertProvider(record, id, providerData));
      } catch (error) {
        if (error instanceof ProviderAlreadyExistsError) {
          return context.json({ error: 'provider id already exists', id: error.providerId }, 409);
        }
        if (error instanceof ConfigReloadRejectedError) {
          return context.json({ error: 'config rejected', detail: error.message }, 422);
        }
        throw error;
      }
      const summaries = await state.providerSummaries({ filter: id, probe: false });
      const provider = summaries[0];
      if (provider === undefined) {
        return context.json({ error: 'provider summary not found' }, 500);
      }
      return context.json({ provider }, 201);
    })
    .put('/providers/routing', providerRoutingMutationValidator, async (context) => {
      if (state.configPath === undefined) {
        return context.json({ error: 'config_unavailable' } as const, 409);
      }
      const providerIds = state.currentConfig().providers.map((provider) => provider.id);
      try {
        await state.configStore.mutateProviders((record) =>
          applyProviderRoutingMutation(record, context.req.valid('json'), providerIds),
        );
      } catch (error) {
        if (error instanceof ProviderRoutingStaleRevisionError) {
          return context.json({ error: 'stale_revision' } as const, 409);
        }
        if (error instanceof ProviderRoutingSetChangedError) {
          return context.json({ error: 'provider_set_changed' } as const, 409);
        }
        if (error instanceof ConfigReloadRejectedError) {
          return context.json({ error: 'validation_failed' } as const, 422);
        }
        throw error;
      }
      const providers = await state.providerSummaries({ probe: false });
      const nextProviderIds = state.currentConfig().providers.map((provider) => provider.id);
      const rawProviders = (await state.configStore.file?.read())?.['providers'];
      return context.json({
        providers,
        routingRevision: providerRoutingRevision(
          typeof rawProviders === 'object' && rawProviders !== null && !Array.isArray(rawProviders)
            ? (rawProviders as Record<string, unknown>)
            : {},
          nextProviderIds,
        ),
      });
    })
    .put('/providers/:id', providerMutationValidator, async (context) => {
      if (state.configPath === undefined) {
        return context.json({ error: 'config file path is not configured' }, 409);
      }
      const id = context.req.param('id');
      const { authored, materialized } = context.req.valid('json');
      if (materialized.id !== id) {
        return context.json({ error: 'provider rename not supported' }, 400);
      }
      const { id: _id, ...bodyRest } = authored;
      const providerData: Record<string, unknown> = { ...bodyRest };
      try {
        await state.configStore.mutateProviders((record) =>
          materialized.kind === 'oauth'
            ? replaceOAuthProvider(record, id, providerData)
            : replaceProvider(record, id, providerData),
        );
      } catch (error) {
        if (error instanceof ProviderNotFoundError) {
          return context.json({ error: 'provider not found' }, 404);
        }
        if (error instanceof ConfigReloadRejectedError) {
          return context.json({ error: 'config rejected', detail: error.message }, 422);
        }
        throw error;
      }
      const summaries = await state.providerSummaries({ filter: id, probe: false });
      const provider = summaries[0];
      if (provider === undefined) {
        return context.json({ error: 'provider summary not found' }, 500);
      }
      return context.json({ provider });
    })
    .route('/', createDashboardProviderEnableRoute(state))
    .delete('/providers/:id', async (context) => {
      if (state.configPath === undefined) {
        return context.json({ error: 'config file path is not configured' }, 409);
      }
      const id = context.req.param('id');
      if ((await state.providerSummaries({ filter: id, probe: false })).length === 0) {
        return context.json({ error: 'provider not found' }, 404);
      }
      try {
        await state.configStore.deleteProvider(id);
      } catch (error) {
        if (error instanceof AccountCleanupPendingError || error instanceof PendingAccountOperationConflictError) {
          return context.json({ error: 'provider account cleanup pending', id }, 409);
        }
        throw error;
      }
      return context.json({ ok: true, id });
    })
    .post('/providers/install', async (context) => {
      try {
        const request = ProviderInstallRequestSchema.parse(await context.req.json());
        if (!isTrustedProviderPackage(request.npm) && request.confirmed !== true) {
          return context.json({ code: 'confirmation_required', error: 'provider install requires confirmation' }, 400);
        }
        const installed = await npmAdd(request.npm, request.registry);
        return context.json({ installed });
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError) {
          return context.json(
            {
              error: 'provider install requires { npm, confirmed: true, registry? }',
            },
            400,
          );
        }
        if (error instanceof NpmPackageNameError) {
          return context.json({ error: error.message }, 400);
        }
        if (error instanceof NpmLockError) {
          return context.json({ error: error.message }, 423);
        }
        if (
          error instanceof NpmInstallError ||
          error instanceof NpmPackageEntrypointError ||
          error instanceof NpmPackageJsonError
        ) {
          return context.json({ error: error.message }, 502);
        }
        throw error;
      }
    });
