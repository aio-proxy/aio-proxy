import { ProviderProtocol } from '@aio-proxy/types';
import { createParser } from 'eventsource-parser';

import { hasContentDelta } from './content';
import { type ExtractedUsage, isRecord, MAX_SSE_BUFFER_CHARS, parseJson, totalTokens } from './shared';
import { usageFromJson } from './usage';

export type PassthroughObservation = {
  readonly responseId?: string;
  readonly usage?: ExtractedUsage;
};

export type PassthroughSseUsageObserver = {
  readonly feed: (chunk: string) => void;
  readonly finish: () => PassthroughObservation;
  // True once a content delta (generated text/reasoning) has been observed, so
  // callers can align TTFT with the first content token rather than the first
  // byte of lifecycle/metadata framing.
  readonly sawContent: () => boolean;
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

export function createPassthroughSseUsageObserver(protocol: ProviderProtocol): PassthroughSseUsageObserver {
  let active = true;
  let observed: ExtractedUsage | undefined;
  let responseId: string | undefined;
  let sawContent = false;
  const parser = createParser({
    maxBufferSize: MAX_SSE_BUFFER_CHARS,
    onError(error) {
      if (error.type === 'max-buffer-size-exceeded') {
        active = false;
      }
    },
    onEvent(event) {
      if (!active || event.data.length > MAX_SSE_BUFFER_CHARS) {
        active = false;
        return;
      }
      const parsed = parseJson(event.data);
      if (parsed === undefined) {
        return;
      }
      const next = observationFromJson(protocol, parsed);
      if (next.usage !== undefined) {
        observed = mergeObservedUsage(protocol, observed, next.usage);
      }
      responseId = next.responseId ?? responseId;
      if (!sawContent && hasContentDelta(protocol, parsed)) {
        sawContent = true;
      }
    },
  });

  return {
    feed(chunk) {
      if (!active || chunk === '') {
        return;
      }
      try {
        parser.feed(chunk);
      } catch {
        active = false;
      }
    },
    finish() {
      if (active) {
        try {
          parser.feed('\n\n');
          parser.reset();
        } catch {
          active = false;
        }
      }
      return active ? observation(observed, responseId) : {};
    },
    sawContent: () => sawContent,
  };
}

function observationFromJson(protocol: ProviderProtocol, value: unknown): PassthroughObservation {
  return observation(usageFromJson(protocol, value), completedResponseId(protocol, value));
}

function observation(usage: ExtractedUsage | undefined, responseId: string | undefined): PassthroughObservation {
  return {
    ...(responseId === undefined ? {} : { responseId }),
    ...(usage === undefined ? {} : { usage }),
  };
}

function completedResponseId(protocol: ProviderProtocol, value: unknown): string | undefined {
  if (protocol !== ProviderProtocol.OpenAIResponse || !isRecord(value)) return undefined;
  const response = isRecord(value['response']) ? value['response'] : value;
  const completed = value['type'] === 'response.completed' || response['status'] === 'completed';
  return completed && typeof response['id'] === 'string' ? response['id'] : undefined;
}

function mergeObservedUsage(
  protocol: ProviderProtocol,
  current: ExtractedUsage | undefined,
  next: ExtractedUsage,
): ExtractedUsage {
  if (protocol !== ProviderProtocol.Anthropic) {
    return next;
  }
  const merged = { ...current, ...next };
  const total = totalTokens(merged.inputTokens, merged.outputTokens);
  return total === undefined ? merged : { ...merged, totalTokens: total };
}
