import { ProviderProtocol } from '@aio-proxy/types';
import { createParser } from 'eventsource-parser';

import { hasContentDelta } from './content';
import { countResponseItems, createResponseItemCounter, type ResponseItemCounts, withItemCounts } from './event-counts';
import {
  anthropicTotalTokens,
  assertNever,
  type ExtractedUsage,
  isRecord,
  MAX_SSE_BUFFER_CHARS,
  parseJson,
  type UsageExtraction,
  type UsageIssue,
  usageNumber,
} from './shared';
import { usageFromJson } from './usage';

const MAX_SSE_FAILURE_LINE_PREFIX_CHARS = 'event: response.incomplete'.length;

export type PassthroughObservation = {
  readonly failed?: true;
  readonly responseId?: string;
  readonly usage?: ExtractedUsage;
  readonly issues?: readonly UsageIssue[];
};

export type PassthroughSseUsageObserver = {
  readonly feed: (chunk: string) => void;
  readonly finish: () => PassthroughObservation;
  // True once a content delta (generated text/reasoning) has been observed, so
  // callers can align TTFT with the first content token rather than the first
  // byte of lifecycle/metadata framing.
  readonly sawContent: () => boolean;
};

export type PassthroughSseCallbacks = {
  readonly onEvent?: () => void;
  readonly onContent?: () => void;
  readonly onTerminal?: (observation: PassthroughObservation) => void;
};

export function extractPassthroughUsage(protocol: ProviderProtocol, bodyText: string): ExtractedUsage | undefined {
  return extractPassthroughObservation(protocol, bodyText).usage;
}

export function extractPassthroughObservation(protocol: ProviderProtocol, bodyText: string): PassthroughObservation {
  const parsed = parseJson(bodyText);
  if (parsed !== undefined) {
    return observationFromJson(protocol, parsed);
  }

  const observer = createPassthroughSseUsageObserver(protocol);
  observer.feed(bodyText);
  return observer.finish();
}

export function createPassthroughSseUsageObserver(
  protocol: ProviderProtocol,
  callbacks: PassthroughSseCallbacks = {},
): PassthroughSseUsageObserver {
  let active = true;
  let observed: UsageExtraction = { kind: 'absent' };
  let responseId: string | undefined;
  let sawContent = false;
  let failed = false;
  const itemCounter = createResponseItemCounter(protocol);
  let linePrefix = '';
  let lineLength = 0;
  let eventFailed = false;
  let dataLines = 0;
  let skipLineFeed = false;
  const finishLine = () => {
    if (lineLength === 0) {
      failed ||= dataLines > 0 && eventFailed;
      eventFailed = false;
      dataLines = 0;
    } else if (linePrefix === 'event' || linePrefix.startsWith('event:')) {
      const value = linePrefix === 'event' ? '' : linePrefix.slice(6);
      const eventType = value.startsWith(' ') ? value.slice(1) : value;
      eventFailed = lineLength <= linePrefix.length && protocolFailure(protocol, eventType || undefined, undefined);
    } else if (linePrefix === 'data' || linePrefix.startsWith('data:')) {
      dataLines++;
    }
    linePrefix = '';
    lineLength = 0;
  };
  const scanFailureEvents = (chunk: string) => {
    for (const character of chunk) {
      if (skipLineFeed) {
        skipLineFeed = false;
        if (character === '\n') continue;
      }
      if (character === '\r' || character === '\n') {
        finishLine();
        skipLineFeed = character === '\r';
        continue;
      }
      if (linePrefix.length < MAX_SSE_FAILURE_LINE_PREFIX_CHARS) linePrefix += character;
      lineLength++;
    }
  };
  const parser = createParser({
    maxBufferSize: MAX_SSE_BUFFER_CHARS,
    onError(error) {
      if (error.type === 'max-buffer-size-exceeded') {
        active = false;
      }
    },
    onEvent(event) {
      safely(callbacks.onEvent);
      const failEvent = protocolFailure(protocol, event.event, undefined);
      failed ||= failEvent;
      if (!active || event.data.length > MAX_SSE_BUFFER_CHARS) {
        active = false;
        if (failEvent)
          safely(() => callbacks.onTerminal?.(observation(observed, responseId, failed, itemCounter.totals())));
        return;
      }
      if (protocol === ProviderProtocol.OpenAICompatible && event.data.trim() === '[DONE]') {
        safely(() => callbacks.onTerminal?.(observation(observed, responseId, failed, itemCounter.totals())));
        return;
      }
      const parsed = parseJson(event.data);
      const failParsed = protocolFailure(protocol, undefined, parsed);
      failed ||= failParsed;
      if (parsed === undefined) {
        if (failEvent || failParsed)
          safely(() => callbacks.onTerminal?.(observation(observed, responseId, failed, itemCounter.totals())));
        return;
      }
      observed = mergeObservedUsage(protocol, observed, usageFromJson(protocol, parsed));
      itemCounter.observe(event.event, parsed);
      responseId = completedResponseId(protocol, parsed) ?? responseId;
      if (hasContentDelta(protocol, event.event, parsed)) {
        sawContent = true;
        safely(callbacks.onContent);
      }
      if (failEvent || failParsed || isSuccessTerminal(protocol, event.event, parsed)) {
        safely(() => callbacks.onTerminal?.(observation(observed, responseId, failed, itemCounter.totals())));
      }
    },
  });

  return {
    feed(chunk) {
      if (chunk === '') return;
      scanFailureEvents(chunk);
      if (!active) return;
      try {
        parser.feed(chunk);
      } catch {
        active = false;
      }
    },
    finish() {
      scanFailureEvents('\n\n');
      if (active) {
        try {
          parser.feed('\n\n');
          parser.reset();
        } catch {
          active = false;
        }
      }
      return failed || active ? observation(observed, responseId, failed, itemCounter.totals()) : {};
    },
    sawContent: () => sawContent,
  };
}

function safely(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {}
}

function observationFromJson(protocol: ProviderProtocol, value: unknown): PassthroughObservation {
  return observation(
    usageFromJson(protocol, value),
    completedResponseId(protocol, value),
    protocolFailure(protocol, undefined, value),
    countResponseItems(protocol, value),
  );
}

function observation(
  usage: UsageExtraction,
  responseId: string | undefined,
  failed: boolean,
  itemCounts: ResponseItemCounts = {},
): PassthroughObservation {
  if (failed) return { failed: true };
  const baseUsage = usage.kind === 'valid' ? usage.usage : undefined;
  const mergedUsage = withItemCounts(baseUsage, itemCounts);
  return {
    ...(responseId === undefined ? {} : { responseId }),
    ...(mergedUsage === undefined ? {} : { usage: mergedUsage }),
    ...(usage.kind === 'invalid' ? { issues: usage.issues } : {}),
  };
}

function protocolFailure(protocol: ProviderProtocol, eventType: string | undefined, value: unknown): boolean {
  if (eventType === 'error') return true;
  if (
    protocol === ProviderProtocol.OpenAIResponse &&
    (eventType === 'response.failed' || eventType === 'response.incomplete' || eventType === 'response.cancelled')
  )
    return true;
  if (!isRecord(value)) return false;
  if (value['type'] === 'error' || isRecord(value['error'])) return true;
  if (protocol !== ProviderProtocol.OpenAIResponse) return false;
  const response = isRecord(value['response']) ? value['response'] : value;
  return (
    value['type'] === 'response.failed' ||
    value['type'] === 'response.incomplete' ||
    value['type'] === 'response.cancelled' ||
    response['status'] === 'failed' ||
    response['status'] === 'incomplete' ||
    response['status'] === 'cancelled'
  );
}

function isSuccessTerminal(protocol: ProviderProtocol, eventType: string | undefined, value: unknown): boolean {
  switch (protocol) {
    case ProviderProtocol.OpenAIResponse: {
      const type = eventType ?? (isRecord(value) ? value['type'] : undefined);
      if (type === 'response.completed' || type === 'response.done') return true;
      const response = isRecord(value) && isRecord(value['response']) ? value['response'] : value;
      return isRecord(response) && response['status'] === 'completed';
    }
    case ProviderProtocol.Anthropic: {
      const type = eventType ?? (isRecord(value) ? value['type'] : undefined);
      return type === 'message_stop';
    }
    case ProviderProtocol.OpenAICompatible: {
      // The terminal frame is `[DONE]` (handled in onEvent), not `finish_reason`:
      // with stream_options.include_usage the usage arrives in a trailing
      // `choices:[]` frame AFTER finish_reason, so resolving on finish_reason
      // would drop token/cost accounting.
      return false;
    }
    case ProviderProtocol.Gemini: {
      // Gemini SSE has no unambiguous stream-level terminal sentinel. With
      // generationConfig.candidateCount > 1 candidates finish in separate frames
      // and the aggregate usageMetadata can trail the first candidate's
      // finishReason, so firing here would settle the trace early and drop the
      // later candidates' token/cost accounting. Defer to the EOF completion,
      // which observes the fully merged usage.
      return false;
    }
    case ProviderProtocol.GeminiInteractions: {
      const type = eventType ?? (isRecord(value) ? value['event_type'] : undefined);
      return type === 'interaction.completed';
    }
    case ProviderProtocol.OpenAIImage:
      return false;
    default:
      return assertNever(protocol);
  }
}

function completedResponseId(protocol: ProviderProtocol, value: unknown): string | undefined {
  if (protocol !== ProviderProtocol.OpenAIResponse || !isRecord(value)) return undefined;
  const response = isRecord(value['response']) ? value['response'] : value;
  const completed = value['type'] === 'response.completed' || response['status'] === 'completed';
  if (!completed || typeof response['id'] !== 'string') return undefined;
  const responseId = response['id'].trim();
  return responseId === '' ? undefined : responseId;
}

function mergeObservedUsage(
  protocol: ProviderProtocol,
  current: UsageExtraction,
  next: UsageExtraction,
): UsageExtraction {
  if (current.kind === 'invalid') return current;
  if (next.kind === 'invalid') return next;
  if (next.kind === 'absent') return current;
  if (protocol !== ProviderProtocol.Anthropic) {
    return next;
  }
  const merged = { ...(current.kind === 'valid' ? current.usage : {}), ...next.usage };
  const total = usageNumber(
    anthropicTotalTokens(merged.inputTokens, merged.outputTokens, merged.cacheWriteTokens, merged.cacheReadTokens),
    'totalTokens',
  );
  if (total.kind === 'invalid') return { kind: 'invalid', issues: [total.issue] };
  return {
    kind: 'valid',
    usage: total.kind === 'absent' ? merged : { ...merged, totalTokens: total.value },
  };
}
