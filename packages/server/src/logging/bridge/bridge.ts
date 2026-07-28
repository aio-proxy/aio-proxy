import type { PluginLogSink } from '@aio-proxy/core';
import type { Logger, LogLevel } from '@aio-proxy/plugin-sdk';

import { currentRequestLogContext } from '../../request-logging';
import type { ServerLog, ServerLogSink } from '../../server-log';

export const SERVER_LOG_LEVEL = {
  'config.reload_failed': 'error',
  'dashboard.auth_unavailable': 'error',
  'request.body_chunk': 'debug',
  'request.body_terminal': 'debug',
  'request.failed': 'error',
  'request.feature_downgraded': 'info',
  'request.inbound_snapshot': 'debug',
  'request.provider_attempt_failed': 'warn',
  'request.recorder_invariant': 'warn',
  'request.rejected': 'warn',
  'trace.persistence_failed': 'error',
  'request.upstream_result': 'debug',
  'request.upstream_snapshot': 'debug',
  'usage.accounting_dropped': 'warn',
} as const satisfies Readonly<Record<ServerLog['event'], LogLevel>>;

type SinkFallbackOptions<Entry> = {
  readonly isConfigured: () => boolean;
  readonly fallback: (entry: Entry) => void;
};

const contextual = <Entry extends object>(entry: Entry) => ({
  ...entry,
  ...currentRequestLogContext(),
});

export function createServerLogSink(logger: Logger, options?: SinkFallbackOptions<ServerLog>): ServerLogSink {
  return (entry) => {
    if (options !== undefined && !options.isConfigured()) {
      options.fallback(contextual(entry));
      return;
    }
    logger[SERVER_LOG_LEVEL[entry.event]](contextual(entry));
  };
}

type PluginLogEntry = Parameters<PluginLogSink>[0];

export function createPluginLogSink(
  createLogger: (context: PluginLogEntry['context']) => Logger,
  options?: SinkFallbackOptions<PluginLogEntry>,
): PluginLogSink {
  return (entry) => {
    if (options !== undefined && !options.isConfigured()) {
      options.fallback(contextual(entry));
      return;
    }
    createLogger(entry.context).error(contextual(entry));
  };
}
