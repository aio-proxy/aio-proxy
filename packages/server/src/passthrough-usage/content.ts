import { ProviderProtocol } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import { codePointLength } from '../live-metrics';
import { assertNever, nonEmptyString } from './shared';

// Whether one parsed SSE event carries generated content (text, reasoning, or
// tool-call arguments), aligned with the streaming path's TTFT trigger. Agent
// turns often emit only a tool call, so excluding arguments left them without
// TTFT. Lifecycle/metadata frames (response.created, message_start, ping) return false.
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
      if (delta['type'] === 'arguments_delta') return nonEmptyString(delta['arguments']);
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

// signature_delta frames are not generated content. Tool input often opens with
// an empty partial_json frame, which does not count either.
function anthropicContent(value: unknown): boolean {
  if (!isPlainObject(value) || value['type'] !== 'content_block_delta') return false;
  const delta = value['delta'];
  if (!isPlainObject(delta)) return false;
  if (delta['type'] === 'input_json_delta') return nonEmptyString(delta['partial_json']);
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
      nonEmptyString(delta['reasoning']) ||
      // The opener frame carries id/name with empty arguments; wait for real output.
      (Array.isArray(delta['tool_calls']) &&
        delta['tool_calls'].some(
          (call) =>
            isPlainObject(call) && isPlainObject(call['function']) && nonEmptyString(call['function']['arguments']),
        ))
    );
  });
}

function openAIResponsesContent(eventType: string | undefined, value: unknown): boolean {
  const type = eventType ?? (isPlainObject(value) ? value['type'] : undefined);
  if (type === 'response.function_call_arguments.delta' || type === 'response.custom_tool_call_input.delta') {
    return isPlainObject(value) && nonEmptyString(value['delta']);
  }
  return (
    type === 'response.output_text.delta' ||
    type === 'response.reasoning_text.delta' ||
    type === 'response.reasoning_summary_text.delta'
  );
}

// Used only when no incremental content has been seen, so customary
// done-after-delta frames do not invent a content gap. Covers outputs that
// stream no deltas: Responses relays that buffer a whole item onto
// output_item.done, and zero-argument tool calls, which only ever emit an
// empty opener before the frame that completes the call. Empty shells and
// hosted tool items (web search, image generation) do not count.
//
// Stateful per stream: an Interactions step.stop does not name its step type,
// so function_call step indices are remembered from step.start.
export function createTtftFallbackDetector(
  protocol: ProviderProtocol,
): (eventType: string | undefined, value: unknown) => boolean {
  const functionCallSteps = new Set<unknown>();
  return (eventType, value) => {
    if (!isPlainObject(value)) return false;
    if (protocol === ProviderProtocol.GeminiInteractions) {
      const type = eventType ?? value['event_type'];
      const step = value['step'];
      if (type === 'step.start' && isPlainObject(step) && step['type'] === 'function_call') {
        functionCallSteps.add(value['index']);
      }
      return type === 'step.stop' && functionCallSteps.has(value['index']);
    }
    return hasTtftFallbackContent(protocol, eventType, value);
  };
}

function hasTtftFallbackContent(
  protocol: ProviderProtocol,
  eventType: string | undefined,
  value: Record<string, unknown>,
): boolean {
  switch (protocol) {
    case ProviderProtocol.OpenAIResponse: {
      const type = eventType ?? value['type'];
      return type === 'response.output_item.done' && openAIResponsesItemHasGeneratedText(value['item']);
    }
    case ProviderProtocol.OpenAICompatible:
      return (
        Array.isArray(value['choices']) &&
        value['choices'].some((choice) => isPlainObject(choice) && choice['finish_reason'] === 'tool_calls')
      );
    case ProviderProtocol.Anthropic:
      return (
        value['type'] === 'message_delta' &&
        isPlainObject(value['delta']) &&
        value['delta']['stop_reason'] === 'tool_use'
      );
    default:
      return false;
  }
}

function openAIResponsesItemHasGeneratedText(item: unknown): boolean {
  if (!isPlainObject(item)) return false;
  const type = item['type'];
  if (type === 'message') return partsHaveNonEmptyText(item['content']);
  if (type === 'reasoning') {
    return partsHaveNonEmptyText(item['content']) || partsHaveNonEmptyText(item['summary']);
  }
  // A completed call is generated output even with empty input (zero-argument tools).
  if (type === 'function_call' || type === 'custom_tool_call') return true;
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
    return candidate['content']['parts'].some(
      (part) => isPlainObject(part) && (nonEmptyString(part['text']) || isPlainObject(part['functionCall'])),
    );
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
