import { canonicalizeLoopbackHost } from '@aio-proxy/core';
import type { Config } from '@aio-proxy/types';

import { logServerEvent, type ServerLogSink } from '../server-log';

/** Warns when `config` admits every caller and `host` is reachable from the network. Advisory
 *  only: the operator may be behind their own gateway, so this never blocks a start or a
 *  reload. `host` is the bound host, which a `--host` flag can move away from `server.host`. */
export function warnUnenforcedApiKeys(host: string | undefined, config: Config, logger: ServerLogSink): void {
  if (config.server.requireApiKey) return;
  if (host === undefined || canonicalizeLoopbackHost(host) !== undefined) return;
  logServerEvent(logger, { event: 'server.api_key_enforcement_disabled', host });
}
