import { ProviderProtocol } from '@aio-proxy/types';

import { assertNever, isRecord, nonEmptyString } from './shared';

// Whether one parsed SSE event carries generated content (text or reasoning),
// aligned with the streaming path's text-delta/reasoning-delta TTFT trigger.
// Lifecycle/metadata frames (response.created, message_start, ping) return false.
export function hasContentDelta(protocol: ProviderProtocol, value: unknown): boolean {
  switch (protocol) {
    case ProviderProtocol.OpenAICompatible:
      return openAICompatibleContent(value);
    case ProviderProtocol.OpenAIResponse:
      return openAIResponsesContent(value);
    case ProviderProtocol.Anthropic:
      return isRecord(value) && value['type'] === 'content_block_delta';
    case ProviderProtocol.Gemini:
      return geminiContent(value);
    default:
      return assertNever(protocol);
  }
}

function openAICompatibleContent(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value['choices'])) return false;
  return value['choices'].some((choice) => {
    if (!isRecord(choice) || !isRecord(choice['delta'])) return false;
    const delta = choice['delta'];
    return (
      nonEmptyString(delta['content']) ||
      nonEmptyString(delta['reasoning_content']) ||
      nonEmptyString(delta['reasoning'])
    );
  });
}

function openAIResponsesContent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = value['type'];
  return (
    type === 'response.output_text.delta' ||
    type === 'response.reasoning_text.delta' ||
    type === 'response.reasoning_summary_text.delta'
  );
}

function geminiContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => geminiContent(entry));
  if (!isRecord(value) || !Array.isArray(value['candidates'])) return false;
  return value['candidates'].some((candidate) => {
    if (!isRecord(candidate) || !isRecord(candidate['content']) || !Array.isArray(candidate['content']['parts'])) {
      return false;
    }
    return candidate['content']['parts'].some((part) => isRecord(part) && nonEmptyString(part['text']));
  });
}
