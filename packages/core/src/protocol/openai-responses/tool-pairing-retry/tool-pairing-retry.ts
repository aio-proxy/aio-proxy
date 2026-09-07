import { isPlainObject } from 'es-toolkit/predicate';

import { responsesErrorCode, responsesErrorMessage } from '../error-payload';

// Both rejections carry `code: null`, so prose is the identity here. The two
// repairable shapes, verbatim from the Responses API:
//   400 No tool call found for function call output with call_id call_… .
//   400 No tool output found for function call call_… .
// `No tool output found for *tool call* …` is deliberately absent: strict
// gateways emit it when an assistant `message` sits between a call and its
// output, which pairing cannot repair (see hoistInterleavedResponsesToolBatch
// in the oh-my-pi reference). Claiming 'retry' for it would spend an extra
// billed round trip on a body the rewrite leaves unchanged.
const ORPHAN_OUTPUT_MESSAGE = /^No tool call found for function call output\b/;
const UNANSWERED_CALL_MESSAGE = /^No tool output found for function call\b/;

export function isToolPairingRejection(payload: Record<string, unknown> | undefined): boolean {
  // An explicit code is authoritative, exactly as in isEncryptedContentRejection:
  // a provider that named a different failure must not be handed a rewrite.
  if (responsesErrorCode(payload) !== undefined) return false;
  const message = responsesErrorMessage(payload)?.trim();
  if (message === undefined) return false;
  return ORPHAN_OUTPUT_MESSAGE.test(message) || UNANSWERED_CALL_MESSAGE.test(message);
}

const CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

// Narrates unpaired tool items as plain messages. Mirrors the model path's
// semantics exactly (convertUnansweredToolCall / convertOrphanToolCallOutput in
// transform/openai-responses/compat.ts): a call the transcript never answers
// becomes assistant prose, an output with no call becomes user prose, and no
// tool return is ever fabricated. Returns undefined when everything pairs, so
// a well-formed body is never rewritten.
//
// A note is emitted in place only while no tool batch is open. Substituting one
// between a paired call and its output would wedge a `message` item into that
// batch — the interleaving isToolPairingRejection deliberately refuses to
// retry — so the replay would just earn a second 400. Notes raised inside an
// open batch are held and emitted once the batch closes. Only our own synthetic
// notes move; every item the caller sent keeps its position.
export function repairOpenAIResponsesToolPairing(input: readonly unknown[]): unknown[] | undefined {
  const answered = answeredCallIds(input);
  const seen = new Set<string>();
  const awaiting = new Set<string>();
  const held: unknown[] = [];
  const next: unknown[] = [];
  let changed = false;
  const emit = (item: unknown) => {
    if (awaiting.size > 0) held.push(item);
    else next.push(item);
  };
  const close = (callId: string) => {
    awaiting.delete(callId);
    if (awaiting.size > 0) return;
    next.push(...held);
    held.length = 0;
  };

  for (const item of input) {
    if (!isPlainObject(item) || typeof item['type'] !== 'string') {
      next.push(item);
      continue;
    }
    const type = item['type'];
    const callId = typeof item['call_id'] === 'string' ? item['call_id'] : undefined;
    if (CALL_TYPES.has(type)) {
      if (callId !== undefined) seen.add(callId);
      if (callId !== undefined && answered.has(callId)) {
        next.push(item);
        awaiting.add(callId);
        continue;
      }
      changed = true;
      emit(unansweredCallNote(item, type));
      continue;
    }
    if (!OUTPUT_TYPES.has(type)) {
      next.push(item);
      continue;
    }
    // Same forward-pass rule as answeredCallIds: only an output positioned
    // after its call pairs. An output without call_id can never pair.
    if (callId !== undefined && seen.has(callId) && answered.has(callId)) {
      next.push(item);
      close(callId);
      continue;
    }
    changed = true;
    emit(orphanOutputNote(item, callId));
  }
  next.push(...held);
  return changed ? next : undefined;
}

// Only an output positioned after its call counts, matching the model path's
// answeredCallIds. Both sides must agree, or one would treat a pair as broken
// while the other treats it as sound.
function answeredCallIds(input: readonly unknown[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const answered = new Set<string>();
  for (const item of input) {
    if (!isPlainObject(item) || typeof item['type'] !== 'string') continue;
    const callId = typeof item['call_id'] === 'string' ? item['call_id'] : undefined;
    if (CALL_TYPES.has(item['type'])) {
      if (callId !== undefined) seen.add(callId);
      continue;
    }
    if (!OUTPUT_TYPES.has(item['type'])) continue;
    if (callId !== undefined && seen.has(callId)) answered.add(callId);
  }
  return answered;
}

// Arguments are carried as the caller wrote them so the note stays byte-stable
// across turns and keeps upstream prefix caching intact.
function unansweredCallNote(item: Record<string, unknown>, type: string): Record<string, unknown> {
  const name = typeof item['name'] === 'string' ? item['name'] : 'tool';
  const rawArgs = type === 'custom_tool_call' ? item['input'] : item['arguments'];
  const args = typeof rawArgs === 'string' ? rawArgs : '';
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: `[unanswered tool call: ${name}(${args})]` }],
  };
}

// A proxy must not decide the output is worthless: text, images, and files all
// survive. Only the tool-result framing is lost, because no call exists to
// attach it to.
function orphanOutputNote(item: Record<string, unknown>, callId: string | undefined): Record<string, unknown> {
  const label = callId === undefined ? '[orphan tool result]' : `[orphan tool result; call_id=${callId}]`;
  const output = item['output'];
  if (typeof output === 'string') {
    return { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${label} ${output}` }] };
  }
  const parts: unknown[] = [{ type: 'input_text', text: label }];
  for (const part of Array.isArray(output) ? output : []) {
    const carried = carryOutputPart(part);
    if (carried !== undefined) parts.push(carried);
  }
  return { type: 'message', role: 'user', content: parts };
}

// `output_text` / `text` are not valid in a user message; normalize them. An
// `encrypted_content` part is dropped: it is only meaningful inside the
// tool-result framing this note no longer has.
function carryOutputPart(part: unknown): unknown {
  if (!isPlainObject(part) || typeof part['type'] !== 'string') return undefined;
  const type = part['type'];
  if (type === 'input_image' || type === 'input_file') return part;
  if (type !== 'input_text' && type !== 'output_text' && type !== 'text') return undefined;
  return typeof part['text'] === 'string' ? { ...part, type: 'input_text' } : undefined;
}
