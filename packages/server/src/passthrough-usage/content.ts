import { ProviderProtocol } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

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

// Some Responses relays buffer the whole item and emit it on output_item.done
// with no preceding *.delta frames. Use only when no incremental content has
// been seen, so customary done-after-delta frames do not invent a content gap.
// Empty shells and hosted tool items (web search, image generation) do not count.
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
  if (type === 'function_call') return nonEmptyString(item['arguments']);
  if (type === 'custom_tool_call') return nonEmptyString(item['input']);
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
