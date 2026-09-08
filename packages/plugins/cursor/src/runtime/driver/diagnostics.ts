import type { Logger } from '@aio-proxy/plugin-sdk';
import type { Message } from '@bufbuild/protobuf';

import type { AgentClientMessage, AgentServerMessage } from '../../gen/agent_pb';

type Phase =
  | 'run-start'
  | 'first-frame'
  | 'first-text'
  | 'tool-ready'
  | 'tool-handoff'
  | 'query-reply'
  | 'turn-ended'
  | 'connect-end'
  | 'http-eof'
  | 'settled';
type Fields = {
  elapsedMs?: number;
  frameCount?: number;
  openToolCount?: number;
  readyToolCount?: number;
  queryCase?: string;
  queryId?: number;
  termination?: string;
  lastInboundAgeMs?: number;
  lastProgressAgeMs?: number;
};
const safeLabel = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;

type ProtocolEvent = {
  direction: 'inbound' | 'outbound';
  elapsedMs: number;
  messageCase: string;
  detailCase?: string;
  resultCase?: string;
  toolCase?: string;
  id?: number;
  unknownFieldNumbers?: number[];
};

function unknownFields(event: ProtocolEvent, message: Message | undefined): void {
  const numbers = message?.$unknown?.slice(0, 8).map((field) => field.no);
  if (numbers?.length) event.unknownFieldNumbers = numbers;
}

export function createRunDiagnostics(
  logger: Logger | undefined,
  context: {
    requestId: string;
    providerId?: string;
    modelId: string;
    resumeMode: 'fresh' | 'checkpoint' | 'tool-results';
  },
) {
  const base: Record<string, unknown> = {
    requestId: safeLabel(context.requestId) ?? crypto.randomUUID(),
    modelId: safeLabel(context.modelId) ?? 'unknown',
    resumeMode: context.resumeMode,
  };
  const providerId = safeLabel(context.providerId);
  if (providerId !== undefined) base['providerId'] = providerId;
  const startedAt = Date.now();
  const recent: ProtocolEvent[] = [];
  let heartbeatCount = 0;
  let checkpointCount = 0;
  let dropped = 0;
  const remember = (event: ProtocolEvent) => {
    recent.push(event);
    if (recent.length > 32) {
      recent.shift();
      dropped++;
    }
  };
  const phase = (phase: Phase, fields: Fields = {}, failed = false): void => {
    if (logger === undefined) return;
    const props: Record<string, unknown> = { ...base, phase };
    for (const key of [
      'elapsedMs',
      'frameCount',
      'openToolCount',
      'readyToolCount',
      'queryId',
      'lastInboundAgeMs',
      'lastProgressAgeMs',
    ] as const) {
      const value = fields[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) props[key] = value;
    }
    for (const key of ['queryCase', 'termination'] as const) {
      const value = safeLabel(fields[key]);
      if (value !== undefined) props[key] = value;
    }
    if (phase === 'settled') {
      props['heartbeatCount'] = heartbeatCount;
      props['checkpointCount'] = checkpointCount;
      props['protocolEventsDropped'] = dropped;
      props['recentProtocolEvents'] = [...recent];
    }
    try {
      if (failed) logger.warn('Cursor Run phase', props);
      else logger.debug('Cursor Run phase', props);
    } catch {
      // Logging must not change the stream or terminal result.
    }
  };
  return {
    phase,
    inbound(server: AgentServerMessage): void {
      if (logger === undefined) return;
      const message = server.message;
      // Keep liveness traffic from evicting the exec/query that preceded a stall.
      if (message.case === 'interactionUpdate' && message.value.message.case === 'heartbeat') {
        heartbeatCount++;
        return;
      }
      if (message.case === 'conversationCheckpointUpdate') {
        checkpointCount++;
        return;
      }
      const event: ProtocolEvent = {
        direction: 'inbound',
        elapsedMs: Date.now() - startedAt,
        messageCase: message.case ?? 'unknown',
      };
      unknownFields(event, server);
      if (message.case === 'interactionUpdate') {
        const update = message.value.message;
        event.detailCase = update.case ?? 'unknown';
        unknownFields(event, message.value);
        if (
          update.case === 'toolCallStarted' ||
          update.case === 'partialToolCall' ||
          update.case === 'toolCallCompleted'
        ) {
          event.toolCase = update.value.toolCall?.tool.case ?? 'unknown';
          unknownFields(event, update.value.toolCall);
        }
      } else if (message.case === 'execServerMessage' || message.case === 'kvServerMessage') {
        event.detailCase = message.value.message.case ?? 'unknown';
        event.id = message.value.id;
        unknownFields(event, message.value);
      } else if (message.case === 'interactionQuery') {
        event.detailCase = message.value.query.case ?? 'unknown';
        event.id = message.value.id;
        unknownFields(event, message.value);
      }
      remember(event);
    },
    outbound(message: AgentClientMessage['message']): void {
      if (logger === undefined) return;
      const event: ProtocolEvent = {
        direction: 'outbound',
        elapsedMs: Date.now() - startedAt,
        messageCase: message.case ?? 'unknown',
      };
      if (message.case === 'execClientMessage') {
        event.id = message.value.id;
        const reply = message.value.message;
        event.detailCase = reply.case ?? 'unknown';
        if (reply.case === 'shellStream') event.resultCase = reply.value.event.case ?? 'unknown';
        else if (reply.value !== undefined && 'result' in reply.value)
          event.resultCase = reply.value.result.case ?? 'unknown';
      } else if (message.case === 'execClientControlMessage') {
        event.detailCase = message.value.message.case ?? 'unknown';
        event.id = message.value.message.value?.id;
      }
      remember(event);
    },
  };
}
