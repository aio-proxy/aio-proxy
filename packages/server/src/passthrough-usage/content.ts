import { ProviderProtocol } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import { codePointLength } from '../live-metrics';
import { assertNever, nonEmptyString } from './shared';

// Whether one parsed SSE event carries generated content (text or reasoning),
// aligned with the streaming path's text-delta/reasoning-delta TTFT trigger.
// Lifecycle/metadata frames (response.created, message_start, ping) return false.
export function hasContentDelta(protocol: ProviderProtocol, eventType: string | undefined, value: unknown): boolean {
  switch (protocol) {
    case ProviderProtocol.OpenAICompatible:
      return openAICompatibleContent(value);
    case ProviderProtocol.OpenAIResponse:
      return openAIResponsesContent(eventType, value);
    case ProviderProtocol.Anthropic:
      return anthropicContent(value);
    case ProviderProtocol.Gemini:
      return geminiContent(value);
    case ProviderProtocol.GeminiInteractions: {
      const type = eventType ?? (isPlainObject(value) ? value['event_type'] : undefined);
      if (type !== 'step.delta' || !isPlainObject(value)) return false;
      const delta = value['delta'];
      if (!isPlainObject(delta)) return false;
      if (delta['type'] === 'text') return nonEmptyString(delta['text']);
      if (delta['type'] === 'thought_summary') {
        const content = delta['content'];
        return isPlainObject(content) && nonEmptyString(content['text']);
      }
      return false;
    }
    case ProviderProtocol.OpenAIImage:
    case ProviderProtocol.OpenAIAudio:
    case ProviderProtocol.OpenAIVideo:
    // Evaluation adapters answer `wantsStream` false and System One defines no SSE
    // frames, so there is no content delta to detect and no TTFT to report. Not a
    // placeholder: a buffered JSON protocol has no first-token moment.
    case ProviderProtocol.TypeSafeSystemOne:
      return false;
    default:
      return assertNever(protocol);
  }
}

// Anthropic content_block_delta also carries tool-argument (input_json_delta)
// and signature (signature_delta) frames; only text/thinking deltas are
// generated content, matching the streaming path's TTFT trigger.
function anthropicContent(value: unknown): boolean {
  if (!isPlainObject(value) || value['type'] !== 'content_block_delta') return false;
  const delta = value['delta'];
  if (!isPlainObject(delta)) return false;
  return delta['type'] === 'text_delta' || delta['type'] === 'thinking_delta';
}

function openAICompatibleContent(value: unknown): boolean {
  if (!isPlainObject(value) || !Array.isArray(value['choices'])) return false;
  return value['choices'].some((choice) => {
    if (!isPlainObject(choice)) return false;
    if (nonEmptyString(choice['text'])) return true;
    if (!isPlainObject(choice['delta'])) return false;
    const delta = choice['delta'];
    return (
      nonEmptyString(delta['content']) ||
      nonEmptyString(delta['reasoning_content']) ||
      nonEmptyString(delta['reasoning'])
    );
  });
}

function openAIResponsesContent(eventType: string | undefined, value: unknown): boolean {
  const type = eventType ?? (isPlainObject(value) ? value['type'] : undefined);
  return (
    type === 'response.output_text.delta' ||
    type === 'response.reasoning_text.delta' ||
    type === 'response.reasoning_summary_text.delta'
  );
}

// Some Responses relays buffer the whole message or reasoning item and emit
// it on output_item.done with no preceding *.delta frames. Use only when no
// incremental content has been seen, so customary done-after-delta frames do
// not invent a content gap. Empty shells and tool items still do not count.
export function hasTtftFallbackContent(
  protocol: ProviderProtocol,
  eventType: string | undefined,
  value: unknown,
): boolean {
  if (protocol !== ProviderProtocol.OpenAIResponse) return false;
  const type = eventType ?? (isPlainObject(value) ? value['type'] : undefined);
  if (type !== 'response.output_item.done' || !isPlainObject(value)) return false;
  return openAIResponsesItemHasGeneratedText(value['item']);
}

function openAIResponsesItemHasGeneratedText(item: unknown): boolean {
  if (!isPlainObject(item)) return false;
  const type = item['type'];
  if (type === 'message') return partsHaveNonEmptyText(item['content']);
  if (type === 'reasoning') {
    return partsHaveNonEmptyText(item['content']) || partsHaveNonEmptyText(item['summary']);
  }
  return false;
}

function partsHaveNonEmptyText(parts: unknown): boolean {
  return Array.isArray(parts) && parts.some((part) => isPlainObject(part) && nonEmptyString(part['text']));
}

function geminiContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => geminiContent(entry));
  if (!isPlainObject(value) || !Array.isArray(value['candidates'])) return false;
  return value['candidates'].some((candidate) => {
    if (
      !isPlainObject(candidate) ||
      !isPlainObject(candidate['content']) ||
      !Array.isArray(candidate['content']['parts'])
    ) {
      return false;
    }
    return candidate['content']['parts'].some((part) => isPlainObject(part) && nonEmptyString(part['text']));
  });
}

// Count incremental content only; buffered TTFT fallback frames must not double
// count text already delivered by delta events.
export function contentDeltaLength(protocol: ProviderProtocol, eventType: string | undefined, value: unknown): number {
  if (protocol === ProviderProtocol.Gemini && Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + contentDeltaLength(protocol, eventType, entry), 0);
  }
  if (!isPlainObject(value)) return 0;
  const length = (text: unknown): number => (typeof text === 'string' ? codePointLength(text) : 0);
  switch (protocol) {
    case ProviderProtocol.OpenAICompatible: {
      if (!Array.isArray(value['choices'])) return 0;
      let chars = 0;
      for (const choice of value['choices']) {
        if (!isPlainObject(choice)) continue;
        chars += length(choice['text']);
        const delta = choice['delta'];
        if (isPlainObject(delta)) {
          chars += length(delta['content']) + length(delta['reasoning_content']) + length(delta['reasoning']);
        }
      }
      return chars;
    }
    case ProviderProtocol.OpenAIResponse:
      return openAIResponsesContent(eventType, value) ? length(value['delta']) : 0;
    case ProviderProtocol.Anthropic: {
      if (value['type'] !== 'content_block_delta' || !isPlainObject(value['delta'])) return 0;
      const delta = value['delta'];
      if (delta['type'] === 'text_delta') return length(delta['text']);
      if (delta['type'] === 'thinking_delta') return length(delta['thinking']);
      return 0;
    }
    case ProviderProtocol.Gemini: {
      if (!Array.isArray(value['candidates'])) return 0;
      let chars = 0;
      for (const candidate of value['candidates']) {
        if (!isPlainObject(candidate) || !isPlainObject(candidate['content'])) continue;
        const parts = candidate['content']['parts'];
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (isPlainObject(part)) chars += length(part['text']);
        }
      }
      return chars;
    }
    case ProviderProtocol.GeminiInteractions: {
      if ((eventType ?? value['event_type']) !== 'step.delta' || !isPlainObject(value['delta'])) return 0;
      const delta = value['delta'];
      if (delta['type'] === 'text') return length(delta['text']);
      if (delta['type'] === 'thought_summary' && isPlainObject(delta['content']))
        return length(delta['content']['text']);
      return 0;
    }
    case ProviderProtocol.OpenAIImage:
    case ProviderProtocol.OpenAIAudio:
    case ProviderProtocol.OpenAIVideo:
    case ProviderProtocol.TypeSafeSystemOne:
      return 0;
    default:
      return assertNever(protocol);
  }
}
