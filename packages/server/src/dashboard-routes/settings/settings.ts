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

// Templates are already expanded in `currentConfig()`, so the rows have to come from what is on
// disk: a save round-trips the view straight back through the mutation endpoint, and serving the
// expanded value would write the resolved secret over the `{{env.X}}` reference.
// Without a config file nothing is writable (PUT fails with `config_unavailable`), but the read
// view must still show the keys the proxy is actually enforcing. An unparseable file is the same
// situation: the watcher rejected it, so the runtime still enforces its last valid snapshot, and
// failing the whole endpoint would hide every control until the file is repaired. In both cases the
// runtime keys stand in, and a write is refused before any bytes move.
async function authoredApiKeys(state: ServerState): Promise<readonly unknown[]> {
  const file = state.configStore.file;
  if (file === undefined) return state.currentConfig().server.apiKeys;
  let server: unknown;
  try {
    server = (await file.read())['server'];
  } catch {
    return state.currentConfig().server.apiKeys;
  }
  const keys = isPlainObject(server) ? server['apiKeys'] : undefined;
  return Array.isArray(keys) ? keys : [];
}

// Same policy as provider credentials: this endpoint sits behind the dashboard password (or
// loopback), and the editor round-trips its rows back through the mutation endpoint, so masking
// here would write the mask over the credential. Only `/config` and the CLI mask.
// A non-string key is dropped rather than coerced: it enforces nothing, and the authored file it
// came from is already rejected by the schema.
function apiKeysView(authored: readonly unknown[]): DashboardSettingsView['apiKeys'] {
  return authored.flatMap((entry) => {
    const key = isPlainObject(entry) ? entry['key'] : undefined;
    if (typeof key !== 'string' || key === '') return [];
    const label = isPlainObject(entry) ? entry['label'] : undefined;
    return [{ key, ...(typeof label === 'string' && label !== '' ? { label } : {}) }];
  });
}

function settingsView(config: Config, authored: readonly unknown[]): DashboardSettingsView {
  const logging = config.server.logging ?? defaultLogging;
  return {
    apiKeys: apiKeysView(authored),
    hasPassword: config.server.password !== undefined,
    host: config.server.host,
    logging: {
      enabled: logging.enabled,
      level: logging.level,
      retentionDays: logging.retentionDays,
    },
    port: config.server.port,
    proxy: config.proxy === undefined ? null : '****',
    requireApiKey: config.server.requireApiKey,
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
    mutation.requireApiKey !== undefined ||
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
    // No restart: `requireModelAuthentication` reads the policy from `currentConfig()` per
    // request, so the reload the write triggers is the whole rollout.
    if (mutation.requireApiKey !== undefined && server['requireApiKey'] !== mutation.requireApiKey) {
      nextServer = { ...nextServer, requireApiKey: mutation.requireApiKey };
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
  if (mutation.apiKeys !== undefined) {
    const server = section(next['server'], 'server');
    // The array is authored wholesale from what the editor read: the view already served the
    // authored values, so a submitted row carries the real credential (or its `{{env.X}}`
    // reference) and nothing has to be reconciled against the previous positions.
    next = { ...next, server: { ...server, apiKeys: mutation.apiKeys } };
  }
  return { next, restartRequired };
}

export const createDashboardSettingsRoute = (state: ServerState) =>
  new Hono()
    .get('/', async (context) => context.json(settingsView(state.currentConfig(), await authoredApiKeys(state))))
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
        // A `SyntaxError` means the file on disk no longer parses, so the write is refused
        // before any bytes move — the same "config as authored is unusable" answer as a
        // schema rejection, rather than an unhandled 500.
        if (error instanceof ZodError || error instanceof TypeError || error instanceof SyntaxError) {
          return context.json({ error: { code: 'config_rejected' }, ok: false } as const, 422);
        }
        throw error;
      }
      return context.json({
        ok: true,
        restartRequired,
        settings: settingsView(state.currentConfig(), await authoredApiKeys(state)),
      } as const);
    });
