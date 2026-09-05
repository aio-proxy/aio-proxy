import { isPlainObject } from 'es-toolkit/predicate';

import { looksLikeBackendCiphertext } from '../encrypted-content-retry/index';

// A reasoning item replays upstream in one of two ways: by `id`, which is a
// lookup against the stored response, or by `encrypted_content`, which carries
// the blob inline. With `store: false` nothing was ever stored, so an item that
// has only the id is a lookup that cannot resolve, and the backend answers:
//   Item with id 'rs_…' not found. Items are not persisted when `store` is set
//   to false.
// The proxy mints ids of exactly that shape whenever a turn is served through
// the AI SDK model path, and the encrypted-content retry produces them too by
// dropping an unusable blob, so both paths feed the next turn an id no upstream
// has ever seen. Strip the orphan id and the item replays as new content.
//
// `store: true` is the only mode where a bare id resolves, so it is the only
// mode left untouched. An absent `store` is treated as false: the proxy rejects
// `store: true` on the model path and the ChatGPT Codex backend forces
// `store: false` on every request it accepts.
export function stripOrphanReasoningIds(input: unknown, store: unknown): unknown[] | undefined {
  if (store === true || !Array.isArray(input)) return undefined;

  let changed = false;
  const next = input.map((item) => {
    if (!isPlainObject(item) || item['type'] !== 'reasoning' || !Object.hasOwn(item, 'id')) return item;
    if (carriesReplayableBlob(item['encrypted_content'])) return item;
    changed = true;
    // Only the id goes: the summary is the reasoning the client wants replayed,
    // and dropping the whole item would silently shorten the transcript.
    const { id: _id, ...rest } = item;
    return rest;
  });
  return changed ? next : undefined;
}

function carriesReplayableBlob(value: unknown): boolean {
  return typeof value === 'string' && looksLikeBackendCiphertext(value);
}
