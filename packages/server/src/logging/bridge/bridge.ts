import type { PluginLogSink } from '@aio-proxy/core';
import type { Logger, LogLevel } from '@aio-proxy/plugin-sdk';

import { currentRequestLogContext } from '../../request-logging';
import type { ServerLog, ServerLogSink } from '../../server-log';

export const SERVER_LOG_LEVEL = {
  'config.oauth_leftover_models': 'warn',
  'config.reload_failed': 'error',
  'dashboard.auth_unavailable': 'error',
  'realtime.call_created': 'debug',
  'realtime.call_failed': 'error',
  'realtime.sideband_closed': 'debug',
  'realtime.sideband_opened': 'debug',
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

// Model-conversion downgrades are emitted per candidate, before a model id is
// meaningful for the entry; the ambient request context would attach a
// misleading one.
const MODEL_SCOPED_DOWNGRADE_FEATURES = new Set(['web_search_call', 'orphan_tool_call_output', 'unanswered_tool_call']);

const contextual = <Entry extends object>(entry: Entry): Entry => {
  const result = {
    ...entry,
    ...currentRequestLogContext(),
  };
  if (
    Reflect.get(result, 'event') === 'request.feature_downgraded' &&
    MODEL_SCOPED_DOWNGRADE_FEATURES.has(Reflect.get(result, 'feature') as string)
  ) {
    Reflect.deleteProperty(result, 'requestedModelId');
    Reflect.deleteProperty(result, 'modelId');
  }
  return result;
};

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
