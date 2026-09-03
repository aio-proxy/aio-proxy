import { isPlainObject } from 'es-toolkit/predicate';

import type { OpenAIResponsesCompactRequest } from '../../../ingress/openai-responses/compact';
import type { OpenAIResponsesRequest } from '../../../ingress/openai-responses/index';
import type { RawRetryFrame, RawRetryHook, RawRetryVerdict } from '../../adapter';
import { readRequestText } from '../../request';

type OpenAIResponsesRawRetryContext = { readonly operation?: 'create' | 'compact' };

const CIPHERTEXT = /^[A-Za-z0-9+/=_-]+$/;
const OPAQUE_ITEM_TYPES = new Set(['reasoning', 'compaction', 'compaction_summary', 'context_compaction']);
// Stream-level outcomes.
const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.done',
  'response.failed',
  'response.incomplete',
  'response.cancelled',
]);
// Item lifecycle frames that announce or close a container without carrying
// generated output themselves. `response.output_item.done` is NOT here: it
// carries the completed `item`, and built-in tool items bill through it (see
// createResponseItemCounter in packages/server/src/passthrough-usage/event-counts).
const LIFECYCLE_ITEM_EVENTS = new Set([
  'response.output_item.added',
  'response.content_part.added',
  'response.content_part.done',
  'response.reasoning_summary_part.added',
  'response.reasoning_summary_part.done',
]);
const OUTPUT_ITEM_DONE = 'response.output_item.done';
// An empty message/reasoning shell can close without output; a built-in tool
// call, or any item with content, is generated work that a replay would discard
// and possibly re-bill.
const EMPTY_ITEM_TYPES = new Set(['message', 'reasoning']);
// Every output-bearing Responses event ends in one of these. Matching by suffix
// covers the whole `ResponseStreamEvent` union — text, refusal, reasoning,
// audio, function/custom/mcp/code-interpreter arguments, and partial images —
// instead of an allowlist that silently holds (and would then discard) output
// from an event nobody remembered to name.
const OUTPUT_EVENT_SUFFIXES = ['.delta', '.done', '.partial_image'] as const;

function carriesGeneratedOutput(type: string, payload: Record<string, unknown> | undefined): boolean {
  if (type === OUTPUT_ITEM_DONE) return itemCarriesOutput(payload?.['item']);
  if (LIFECYCLE_ITEM_EVENTS.has(type) || TERMINAL_EVENTS.has(type)) return false;
  return OUTPUT_EVENT_SUFFIXES.some((suffix) => type.endsWith(suffix));
}

// A done frame for a built-in tool (image generation, web search, code
// interpreter, MCP) is billable generated work even with no preceding delta.
// A message/reasoning shell that closed empty is not.
function itemCarriesOutput(item: unknown): boolean {
  if (!isPlainObject(item)) return false;
  const type = item['type'];
  if (typeof type !== 'string') return true;
  if (!EMPTY_ITEM_TYPES.has(type)) return true;
  const content = item['content'];
  const summary = item['summary'];
  return (Array.isArray(content) && content.length > 0) || (Array.isArray(summary) && summary.length > 0);
}

export function looksLikeBackendCiphertext(payload: string): boolean {
  return payload.length >= 64 && CIPHERTEXT.test(payload);
}

// Hold-by-default. `response.output_item.added` and `response.content_part.added`
// are pre-content metadata: this repo's own egress emits output_item.added
// immediately before every delta, so committing there would forfeit the retry
// window this feature exists for. Unknown frames also hold; the 1 MiB replay
// cap, the preflight idle timer, and stream EOF all commit, so nothing hangs.
export function classifyOpenAIResponsesRawRetry(frame: RawRetryFrame): RawRetryVerdict {
  const payload = parseJson(frame.data);
  const type = frame.event ?? (typeof payload?.['type'] === 'string' ? payload['type'] : undefined);
  if (type !== undefined && carriesGeneratedOutput(type, payload)) return 'commit';
  if (type === 'error' || type === 'response.failed' || isPlainObject(payload?.['error'])) {
    return responsesErrorCode(payload) === 'invalid_encrypted_content' ? 'retry' : 'commit';
  }
  if (type !== undefined && TERMINAL_EVENTS.has(type)) return 'commit';
  return 'hold';
}

// Official Responses `event: error` puts `code` on the payload root. ChatGPT
// raw traffic then goes through createOpenAIStreamFetch, which rewrites that
// frame to `response.failed` and stores the original object at
// `response.error` — sometimes wrapping a nested `{ error: { code } }`.
function responsesErrorCode(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) return undefined;
  return errorCodeFrom(payload) ?? errorCodeFrom(isPlainObject(payload['response']) ? payload['response'] : undefined);
}

function errorCodeFrom(value: Record<string, unknown> | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value['code'] === 'string') return value['code'];
  const nested = value['error'];
  if (!isPlainObject(nested)) return undefined;
  if (typeof nested['code'] === 'string') return nested['code'];
  const inner = nested['error'];
  return isPlainObject(inner) && typeof inner['code'] === 'string' ? inner['code'] : undefined;
}

export function rewriteOpenAIResponsesEncryptedContent(bodyText: string): string | undefined {
  const parsed = parseJson(bodyText);
  if (parsed === undefined || !Array.isArray(parsed['input'])) return undefined;

  const withPlaintext = rewritePlaintextSlots(parsed['input']);
  if (withPlaintext !== undefined) return JSON.stringify({ ...parsed, input: withPlaintext });

  const withBlobs = rewriteOpaqueBlobs(parsed['input']);
  if (withBlobs !== undefined) return JSON.stringify({ ...parsed, input: withBlobs });
  return undefined;
}

export const openAIResponsesRawRetry: RawRetryHook<
  OpenAIResponsesRequest | OpenAIResponsesCompactRequest,
  OpenAIResponsesRawRetryContext
> = {
  classify: classifyOpenAIResponsesRawRetry,
  async rewrite(upstream, _request, context) {
    // Compact replay is out of scope: its `input` can also be an array, so the
    // rewrite would otherwise fire on an endpoint this feature does not cover.
    if (context.operation === 'compact') return undefined;
    const body = rewriteOpenAIResponsesEncryptedContent(await readRequestText(upstream.clone()));
    if (body === undefined) return undefined;
    const headers = new Headers(upstream.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    // `signal` comes from the inbound request, so a client disconnect during the
    // replay cancels the second upstream call too.
    return new Request(upstream, { method: upstream.method, body, headers, signal: upstream.signal });
  },
};

function rewritePlaintextSlots(input: readonly unknown[]): unknown[] | undefined {
  let changed = false;
  const next = input.map((item) => {
    if (!isPlainObject(item)) return item;
    if (item['type'] === 'agent_message' && Array.isArray(item['content'])) {
      const content = rewriteParts(item['content']);
      if (content === undefined) return item;
      changed = true;
      return { ...item, content };
    }
    if (item['type'] === 'function_call_output' && Array.isArray(item['output'])) {
      const output = rewriteParts(item['output']);
      if (output === undefined) return item;
      changed = true;
      return { ...item, output };
    }
    return item;
  });
  return changed ? next : undefined;
}

function rewriteParts(parts: readonly unknown[]): unknown[] | undefined {
  let changed = false;
  const next = parts.map((part) => {
    if (!isPlainObject(part) || part['type'] !== 'encrypted_content' || typeof part['encrypted_content'] !== 'string') {
      return part;
    }
    if (looksLikeBackendCiphertext(part['encrypted_content'])) return part;
    changed = true;
    return { type: 'input_text', text: part['encrypted_content'] };
  });
  return changed ? next : undefined;
}

function rewriteOpaqueBlobs(input: readonly unknown[]): unknown[] | undefined {
  let changed = false;
  const next = input.map((item) => {
    if (!isPlainObject(item) || typeof item['type'] !== 'string' || !OPAQUE_ITEM_TYPES.has(item['type'])) return item;
    if (!Object.hasOwn(item, 'encrypted_content')) return item;
    changed = true;
    const { encrypted_content: _encrypted, ...rest } = item;
    return rest;
  });
  return changed ? next : undefined;
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
