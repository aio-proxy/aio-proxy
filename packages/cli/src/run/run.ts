import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { AtomicConfigFile, configPath } from '@aio-proxy/core';
import { ConfigWriteError, m, PortOutOfRangeError } from '@aio-proxy/i18n';

import packageJson from '../../package.json' with { type: 'json' };
import { bootProxyServer } from '../boot-proxy-server';
import type { CliDeps } from '../dashboard-assets';
import { ServeListenError } from '../errors';
import { openBrowser } from '../open-browser';

const VERSION = packageJson.version;
const CONFIG_SCHEMA_URL = `https://cdn.jsdelivr.net/npm/aio-proxy@${VERSION}/config.schema.json`;

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
        m.cli_bootstrap_empty_config({
          path,
          dashboardUrl,
        }),
      );
    }
  }

  return new AtomicConfigFile(path).read();
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
  const host = options.host ?? '127.0.0.1';
  const port = parsePort(options.port, DEFAULT_CONFIG.server.port);
  const apiUrl = `http://${host}:${port}`;
  const dashboardUrl = deps.dashboardUrl?.(apiUrl) ?? `${apiUrl}/dashboard`;
  assertPortAvailable(host, port);
  const config = await readOrBootstrapConfig(resolvedConfigPath, dashboardUrl);
  const dashboardAssets = deps.dashboardAssets();
  const app = await bootProxyServer({
    config,
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
  const server = Bun.serve({ hostname: host, port, idleTimeout: 255, fetch: app.fetch });
  console.error(
    m.cli_run_started({
      apiUrl: `http://${server.hostname}:${server.port}`,
      dashboardUrl,
    }),
  );
  if (options.open === true) {
    openBrowser(dashboardUrl);
  }
};
