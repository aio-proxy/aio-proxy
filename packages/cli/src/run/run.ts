import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { AtomicConfigFile, configPath, parseRuntimeConfig } from '@aio-proxy/core';
import { AppError, ConfigWriteError, m, PortOutOfRangeError } from '@aio-proxy/i18n';

import { EDITS_MULTIPART_ENCODED_LIMIT } from '../../../core/src/ingress/openai-image/multipart-counters';
import packageJson from '../../package.json' with { type: 'json' };
import { bootProxyServer } from '../boot-proxy-server';
import { controlBaseUrl } from '../control-plane';
import type { CliDeps } from '../dashboard-assets';
import { ServeListenError } from '../errors';
import { CliExit, EXIT } from '../exit';
import { openBrowser } from '../open-browser';
import { loadServiceEnv } from '../service-env';

const VERSION = packageJson.version;
// The schema ships with @aio-proxy/types (its Rslib build emits it), not the
// launcher. unpkg (unlike jsdelivr) resolves the package's `exports` map, so the
// bare path works without `dist/`. Deliberately unpinned: nothing rewrites this
// line after bootstrap — `upgrade` can't, because a config transaction
// re-serializes via JSON.stringify and would strip the user's comments — so a
// pinned version would rot and red-underline valid config forever. Tracking
// `latest` can instead surface a field the installed binary predates, which
// fails at parse time with a clear message.
const CONFIG_SCHEMA_URL = 'https://unpkg.com/@aio-proxy/types/config.schema.json';

export const MAX_REQUEST_BODY_SIZE = EDITS_MULTIPART_ENCODED_LIMIT;

export const DEFAULT_CONFIG = {
  $schema: CONFIG_SCHEMA_URL,
  server: { port: 9_317 },
  providers: {},
} as const;

export type RunOptions = {
  readonly host?: string;
  readonly port?: string;
  readonly open?: boolean;
};

export const parsePort = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new PortOutOfRangeError(value);
  }
  return port;
};

export const validatePortArgv = (argv: readonly string[]): void => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') {
      parsePort(argv[index + 1], DEFAULT_CONFIG.server.port);
      return;
    }
    if (arg?.startsWith('--port=')) {
      parsePort(arg.slice('--port='.length), DEFAULT_CONFIG.server.port);
      return;
    }
  }
};

export const readOrBootstrapConfig = async (path: string, dashboardUrl: string) => {
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, `${JSON.stringify(DEFAULT_CONFIG, undefined, 2)}\n`, {
        mode: 0o600,
      });
    } catch (err) {
      if (err instanceof Error) {
        throw new ConfigWriteError(path);
      }
      throw err;
    }
    if (process.stdin.isTTY !== true) {
      console.log(
        m['cli.bootstrap.empty_config']({
          path,
          dashboardUrl,
        }),
      );
    }
  }

  return new AtomicConfigFile(path).read();
};

// Retrying an unchanged bad configuration is futile, so malformed-syntax and
// schema-invalid configs must exit unrecoverable (1), not transient (2) — else
// a service manager restarts the daemon in a loop. A service.env that exists but
// cannot be read (bad perms, is-a-directory) is equally unrecoverable: retrying
// the same broken file loops forever, so classify it as exit 1 too. Already-
// classified errors (AppError such as ConfigWriteError, or a CliExit) keep their
// own code/message. Returns the raw envelope plus the parsed config so the caller
// can honor config-provided host/port without a second parse failing separately.
const loadConfigForRun = async (path: string, dashboardUrl: string) => {
  try {
    // Load the optional service.env before parsing so provider secrets referenced
    // via {{env.*}} resolve under a managed run's clean environment.
    loadServiceEnv(path);
    const raw = await readOrBootstrapConfig(path, dashboardUrl);
    return { raw, config: parseRuntimeConfig(raw) };
  } catch (cause) {
    if (cause instanceof AppError || cause instanceof CliExit) throw cause;
    throw new CliExit(
      EXIT.unrecoverable,
      m['cli.config.invalid']({ error: cause instanceof Error ? cause.message : String(cause) }),
    );
  }
};

const assertPortAvailable = (host: string, port: number) => {
  let probe: { stop(force?: boolean): void } | undefined;
  try {
    probe = Bun.serve({
      hostname: host,
      port,
      fetch: () => new Response(null, { status: 204 }),
    });
  } catch (err) {
    if (err instanceof Error) {
      throw new ServeListenError(host, port, { cause: err });
    }
    throw err;
  } finally {
    probe?.stop(true);
  }
};

export const run = (deps: CliDeps) => async (options: RunOptions) => {
  const resolvedConfigPath = configPath();
  const dashboardUrlFor = (host: string, port: number) => {
    // Reuse controlBaseUrl so an IPv6 host (`::1`) is bracketed — a raw
    // `http://::1:<port>` is an invalid URL and breaks the dashboard / `run --open`.
    const apiUrl = controlBaseUrl(host, String(port));
    return deps.dashboardUrl?.(apiUrl) ?? `${apiUrl}/dashboard`;
  };
  // Resolve the flag values first: they are the only bind info available on a
  // fresh install (no config to read yet), so the bootstrap hint must use them.
  const flagHost = options.host;
  const flagPort = options.port === undefined ? undefined : parsePort(options.port, DEFAULT_CONFIG.server.port);
  // The bootstrap hint (fresh install, no config) can only reflect flags/defaults.
  const bootstrapUrl = dashboardUrlFor(flagHost ?? '127.0.0.1', flagPort ?? DEFAULT_CONFIG.server.port);
  const { raw, config } = await loadConfigForRun(resolvedConfigPath, bootstrapUrl);
  // A bare `run` (managed service, no flags) must honor the config's server.host/
  // server.port; CLI flags still win when present.
  const host = flagHost ?? config.server.host;
  const port = flagPort ?? config.server.port;
  const dashboardUrl = dashboardUrlFor(host, port);
  assertPortAvailable(host, port);
  const dashboardAssets = deps.dashboardAssets();
  const app = await bootProxyServer({
    config: raw,
    configPath: resolvedConfigPath,
    dashboardAssets,
    host,
    port,
    version: VERSION,
  });
  // LLM responses stream with long quiet gaps (slow upstream TTFB, reasoning
  // pauses). Bun's default 10s idle timeout would close the client connection
  // mid-stream, surfacing to clients as "stream disconnected"/decode errors.
  // 255s is Bun's maximum idle window.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: host,
      port,
      idleTimeout: 255,
      maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
      fetch: app.fetch,
    });
  } catch (error) {
    try {
      app.close();
    } catch {}
    throw error;
  }

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    try {
      server.stop(true);
    } finally {
      try {
        app.close();
      } finally {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
      }
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.error(
    m['cli.run.started']({
      apiUrl: controlBaseUrl(server.hostname ?? host, String(server.port)),
      dashboardUrl,
    }),
  );
  if (options.open === true) {
    openBrowser(dashboardUrl);
  }
};
