import {
  type Config,
  type DashboardSettingsMutation,
  type DashboardSettingsMutationInput,
  DashboardSettingsMutationSchema,
  type DashboardSettingsView,
  ServerLoggingSchema,
} from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { ZodError } from 'zod';

import { ConfigPathMissingError, ConfigReloadRejectedError } from '../../config-store';
import type { ServerState } from '../../server-state';

const defaultLogging = ServerLoggingSchema.parse({});

const settingsValidator = validator('json', (raw, context) => {
  const parsed = DashboardSettingsMutationSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: { code: 'config_rejected' }, ok: false } as const, 422);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  {
    in: { json: DashboardSettingsMutationInput };
    out: { json: DashboardSettingsMutation };
  }
>;

function settingsView(config: Config): DashboardSettingsView {
  const logging = config.server.logging ?? defaultLogging;
  return {
    hasPassword: config.server.password !== undefined,
    host: config.server.host,
    logging: {
      enabled: logging.enabled,
      level: logging.level,
      retentionDays: logging.retentionDays,
    },
    port: config.server.port,
    proxy: config.proxy === undefined ? null : '****',
    retryAfterCapMs: config.server.retry.retryAfterCapMs,
  };
}

function section(value: unknown, path: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

async function applySettingsMutation(
  current: Record<string, unknown>,
  mutation: DashboardSettingsMutation,
): Promise<{ readonly next: Record<string, unknown>; readonly restartRequired: boolean }> {
  let next = current;
  let restartRequired = false;
  if (
    mutation.host !== undefined ||
    mutation.port !== undefined ||
    mutation.logging !== undefined ||
    mutation.retryAfterCapMs !== undefined
  ) {
    const server = section(current['server'], 'server');
    let nextServer = server;
    if (mutation.host !== undefined && server['host'] !== mutation.host) {
      nextServer = { ...nextServer, host: mutation.host };
      restartRequired = true;
    }
    if (mutation.port !== undefined && server['port'] !== mutation.port) {
      nextServer = { ...nextServer, port: mutation.port };
      restartRequired = true;
    }
    if (mutation.logging !== undefined) {
      const logging = section(server['logging'], 'server.logging');
      let nextLogging = logging;
      for (const key of ['enabled', 'retentionDays', 'level'] as const) {
        const value = mutation.logging[key];
        if (value !== undefined && logging[key] !== value) {
          nextLogging = { ...nextLogging, [key]: value };
          restartRequired = true;
        }
      }
      if (nextLogging !== logging) nextServer = { ...nextServer, logging: nextLogging };
    }
    if (mutation.retryAfterCapMs !== undefined) {
      const retry = section(server['retry'], 'server.retry');
      if (retry['retryAfterCapMs'] !== mutation.retryAfterCapMs) {
        nextServer = { ...nextServer, retry: { ...retry, retryAfterCapMs: mutation.retryAfterCapMs } };
      }
    }
    if (nextServer !== server) next = { ...next, server: nextServer };
  }
  if (Object.hasOwn(mutation, 'proxy')) {
    if (mutation.proxy === null) {
      if (Object.hasOwn(next, 'proxy')) {
        const { proxy: _proxy, ...withoutProxy } = next;
        next = withoutProxy;
      }
    } else if (next['proxy'] !== mutation.proxy) {
      next = { ...next, proxy: mutation.proxy };
    }
  }
  if (Object.hasOwn(mutation, 'password')) {
    const server = section(next['server'], 'server');
    if (mutation.password === null) {
      if (Object.hasOwn(server, 'password')) {
        const { password: _password, ...withoutPassword } = server;
        next = { ...next, server: withoutPassword };
      }
    } else if (mutation.password !== undefined) {
      next = { ...next, server: { ...server, password: await Bun.password.hash(mutation.password) } };
    }
  }
  return { next, restartRequired };
}

export const createDashboardSettingsRoute = (state: ServerState) =>
  new Hono()
    .get('/', (context) => context.json(settingsView(state.currentConfig())))
    .put('/', settingsValidator, async (context) => {
      const mutation = context.req.valid('json');
      let restartRequired = false;
      try {
        await state.configStore.mutateConfig(async (current) => {
          const result = await applySettingsMutation(current, mutation);
          restartRequired = result.restartRequired;
          return result.next;
        });
      } catch (error) {
        if (error instanceof ConfigPathMissingError) {
          return context.json({ error: { code: 'config_unavailable' }, ok: false } as const, 409);
        }
        if (error instanceof ConfigReloadRejectedError) {
          return context.json({ error: { code: 'reload_failed' }, ok: false } as const, 422);
        }
        if (error instanceof ZodError || error instanceof TypeError) {
          return context.json({ error: { code: 'config_rejected' }, ok: false } as const, 422);
        }
        throw error;
      }
      return context.json({ ok: true, restartRequired, settings: settingsView(state.currentConfig()) } as const);
    });
