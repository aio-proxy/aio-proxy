import { aioHome } from "@aio-proxy/core";
import { configureLogging, type LoggingConfig } from "@aio-proxy/logger";
import { createServer, type CreateServerOptions } from "@aio-proxy/server";
import { ConfigSchema } from "@aio-proxy/types";
import { join } from "node:path";

type BootProxyServerDeps = {
  readonly aioHome: typeof aioHome;
  readonly configureLogging: (config: LoggingConfig) => Promise<void>;
  readonly createServer: typeof createServer;
};

const defaultBootProxyServerDeps: BootProxyServerDeps = { aioHome, configureLogging, createServer };

export const bootProxyServer = async (
  options: CreateServerOptions,
  deps: BootProxyServerDeps = defaultBootProxyServerDeps,
) => {
  const config = ConfigSchema.parse(options.config);
  const logging = config.server.logging;
  await deps.configureLogging({
    dir: logging?.dir ?? join(deps.aioHome(), "logs"),
    ...(logging?.enabled === undefined ? {} : { enabled: logging.enabled }),
    ...(logging?.retentionDays === undefined ? {} : { retentionDays: logging.retentionDays }),
    ...(logging?.level === undefined ? {} : { level: logging.level }),
  });
  return deps.createServer(options);
};
