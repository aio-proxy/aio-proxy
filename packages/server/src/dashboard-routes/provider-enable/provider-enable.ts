import { resolveConfigTemplates } from '@aio-proxy/core';
import {
  type DashboardProviderEnabledMutationBody,
  type DashboardProviderEnabledMutationBodyInput,
  DashboardProviderEnabledMutationBodySchema,
  ProviderSchema,
} from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';

import { ConfigReloadRejectedError } from '../../config-store';
import type { ServerState } from '../../server-state';
import { ProviderNotFoundError } from '../provider-mutation';

const providerEnabledValidator = validator('json', (raw, context) => {
  const parsed = DashboardProviderEnabledMutationBodySchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'validation failed', details: parsed.error.issues }, 400);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  {
    in: { json: DashboardProviderEnabledMutationBodyInput };
    out: { json: DashboardProviderEnabledMutationBody };
  }
>;

function setProviderEnabled(
  record: Record<string, unknown>,
  providerId: string,
  enabled: boolean,
): Record<string, unknown> {
  const provider = record[providerId];
  if (!isPlainObject(provider)) throw new ProviderNotFoundError(providerId);
  let materialized: unknown;
  try {
    materialized = resolveConfigTemplates({ ...provider, id: providerId });
  } catch {
    throw new ProviderNotFoundError(providerId);
  }
  if (!ProviderSchema.safeParse(materialized).success) throw new ProviderNotFoundError(providerId);
  return { ...record, [providerId]: { ...provider, enabled } };
}

export const createDashboardProviderEnableRoute = (state: ServerState) =>
  new Hono().patch('/providers/:id/enabled', providerEnabledValidator, async (context) => {
    if (state.configPath === undefined) {
      return context.json({ error: 'config file path is not configured' }, 409);
    }
    const id = context.req.param('id');
    try {
      const { enabled } = context.req.valid('json');
      await state.configStore.mutateProviders((record) => setProviderEnabled(record, id, enabled));
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        return context.json({ error: 'provider not found' }, 404);
      }
      if (error instanceof ConfigReloadRejectedError) {
        return context.json({ error: 'config rejected', detail: error.message }, 422);
      }
      throw error;
    }
    const provider = (await state.providerSummaries({ filter: id, probe: false })).find((summary) => summary.id === id);
    if (provider === undefined) {
      return context.json({ error: 'provider summary not found' }, 500);
    }
    return context.json({ provider });
  });
