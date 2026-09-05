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
// audio, function/custom/mcp/code-interpreter arguments, partial images, and
// built-in tool completions (`response.web_search_call.completed`,
// `response.mcp_call.completed`, …) — instead of an allowlist that silently
// holds (and would then discard) output from an event nobody remembered to name.
// Stream-level `response.completed` is in TERMINAL_EVENTS, so it is excluded
// here and still classified as a terminal commit.
const OUTPUT_EVENT_SUFFIXES = ['.delta', '.done', '.partial_image', '.completed'] as const;

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
  const encrypted = item['encrypted_content'];
  // Official reasoning often lands as encrypted_content with an empty summary.
  // That blob is generated work; holding the frame would let a later
  // invalid_encrypted_content replay — and re-bill — it.
  return (
    (Array.isArray(content) && content.length > 0) ||
    (Array.isArray(summary) && summary.length > 0) ||
    (typeof encrypted === 'string' && encrypted.length > 0)
  );
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
    return isEncryptedContentRejection(payload) ? 'retry' : 'commit';
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
  return codeFrom(errorChain(payload)) ?? codeFrom(errorChain(responseEnvelope(payload)));
}

// The ChatGPT backend also rejects an unverifiable blob with `code: null` and
// only the prose naming the item, e.g. `The encrypted content for item rs_… could
// not be verified. Reason: Encrypted content could not be decrypted or parsed.`
// Matching the code alone leaves that (very common) variant un-retried. Other
// reasons carried by the same sentence — `Signature expired`, for instance — are
// not blob-decode failures and must keep committing, so the reason is matched too.
const UNVERIFIABLE_BLOB_MESSAGE =
  /^The encrypted content\b.*\bcould not be verified\. Reason: Encrypted content could not be (?:decrypted or parsed|decoded)\.$/;

function isEncryptedContentRejection(payload: Record<string, unknown> | undefined): boolean {
  const code = responsesErrorCode(payload);
  if (code !== undefined) return code === 'invalid_encrypted_content';
  // Prose is the fallback identity only when the provider named no code at all.
  // A different explicit code is authoritative: retrying would silently rewrite
  // and resend a body the provider rejected for an unrelated reason.
  const message = responsesErrorMessage(payload);
  return message !== undefined && UNVERIFIABLE_BLOB_MESSAGE.test(message.trim());
}

function responsesErrorMessage(payload: Record<string, unknown> | undefined): string | undefined {
  if (payload === undefined) return undefined;
  return messageFrom(errorChain(payload)) ?? messageFrom(errorChain(responseEnvelope(payload)));
}

function responseEnvelope(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return isPlainObject(payload['response']) ? payload['response'] : undefined;
}

// Both lookups walk this one chain, so a code can never sit on a node whose
// message was consulted: a depth mismatch would let an explicit non-matching
// code look absent and hand a rewrite-and-resend to the prose fallback.
// Iterative and depth-capped because the chain is provider-controlled — a
// recursive walk over a deeply nested `error` chain (~50k levels fit under the
// 1 MiB body cap) would throw a RangeError out of `classify` instead of
// committing and forwarding the provider's response.
const MAX_ERROR_NESTING = 8;

function errorChain(root: Record<string, unknown> | undefined): readonly Record<string, unknown>[] {
  if (root === undefined) return [];
  const chain: Record<string, unknown>[] = [root];
  for (let node = root['error']; isPlainObject(node) && chain.length < MAX_ERROR_NESTING; node = node['error']) {
    chain.push(node);
  }
  return chain;
}

// Outermost wins: the envelope names the failure the provider is reporting.
function codeFrom(chain: readonly Record<string, unknown>[]): string | undefined {
  for (const node of chain) {
    const code = stringField(node, 'code');
    if (code !== undefined) return code;
  }
  return undefined;
}

// Innermost wins: a wrapper repeats or generalizes the message the backend
// actually issued.
function messageFrom(chain: readonly Record<string, unknown>[]): string | undefined {
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const message = stringField(chain[index]!, 'message');
    if (message !== undefined) return message;
  }
  return undefined;
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  return typeof value[key] === 'string' ? value[key] : undefined;
}

export function rewriteOpenAIResponsesEncryptedContent(bodyText: string): string | undefined {
  const parsed = parseJson(bodyText);
  if (parsed === undefined || !Array.isArray(parsed['input'])) return undefined;

  const withPlaintext = rewritePlaintextSlots(parsed['input']);
  if (withPlaintext !== undefined) return JSON.stringify({ ...parsed, input: withPlaintext });

  const withBlobs = rewriteOpaqueBlobs(parsed['input'], parsed['store']);
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
    if (
      (item['type'] === 'function_call_output' || item['type'] === 'custom_tool_call_output') &&
      Array.isArray(item['output'])
    ) {
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

function rewriteOpaqueBlobs(input: readonly unknown[], store: unknown): unknown[] | undefined {
  let changed = false;
  const next = input.map((item) => {
    if (!isPlainObject(item) || typeof item['type'] !== 'string' || !OPAQUE_ITEM_TYPES.has(item['type'])) return item;
    if (!Object.hasOwn(item, 'encrypted_content')) return item;
    changed = true;
    const { encrypted_content: _encrypted, ...rest } = item;
    // Dropping the blob leaves a reasoning item that can only replay by `id`,
    // and with `store: false` that id was never persisted upstream, so the
    // replay would trade invalid_encrypted_content for a 404 "Item with id …
    // not found". See stripOrphanReasoningIds for the same rule on first send.
    if (rest['type'] !== 'reasoning' || store === true) return rest;
    const { id: _id, ...withoutId } = rest;
    return withoutId;
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
