import { ProviderProtocol } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

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
