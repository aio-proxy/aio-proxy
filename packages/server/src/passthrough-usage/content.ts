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
      return anthropicContent(value);
    case ProviderProtocol.Gemini:
      return geminiContent(value);
    default:
      return assertNever(protocol);
  }
}

// Anthropic content_block_delta also carries tool-argument (input_json_delta)
// and signature (signature_delta) frames; only text/thinking deltas are
// generated content, matching the streaming path's TTFT trigger.
function anthropicContent(value: unknown): boolean {
  if (!isRecord(value) || value['type'] !== 'content_block_delta') return false;
  const delta = value['delta'];
  if (!isRecord(delta)) return false;
  return delta['type'] === 'text_delta' || delta['type'] === 'thinking_delta';
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
