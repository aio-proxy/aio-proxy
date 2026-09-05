import { isPlainObject } from 'es-toolkit/predicate';

// A reasoning item replays upstream in one of two ways: by `id`, which is a
// lookup against the stored response, or by `encrypted_content`, which carries
// the blob inline. This runtime forces `store: false` on every create request,
// so nothing is ever stored and an item that has only the id is a lookup that
// cannot resolve. The backend answers:
//   Item with id 'rs_…' not found. Items are not persisted when `store` is set
//   to false.
// Two paths feed the next turn exactly such an id: a turn served through the AI
// SDK model path leaves the proxy's own minted `rs_resp_…_0` on the item, and
// the invalid_encrypted_content retry strips an unusable blob and replays what
// is left. Dropping the orphan id makes the item replay as new content.
//
// Scoped to this runtime on purpose. The same rewrite one layer up, in the
// shared Responses adapter, would also reach ordinary Responses providers whose
// ids do resolve, and silently break their continuations.
export function stripOrphanReasoningIds(input: unknown): unknown[] | undefined {
  if (!Array.isArray(input)) return undefined;

  let changed = false;
  const next = input.map((item) => {
    if (!isPlainObject(item) || item['type'] !== 'reasoning' || !Object.hasOwn(item, 'id')) return item;
    if (carriesBlob(item['encrypted_content'])) return item;
    changed = true;
    // Only the id goes: the summary is the reasoning the client wants replayed,
    // and dropping the whole item would silently shorten the transcript.
    const { id: _id, ...rest } = item;
    return rest;
  });
  return changed ? next : undefined;
}

// Presence, not validity. A blob the backend cannot verify is rejected with
// invalid_encrypted_content, and that retry deletes the blob and sends the body
// back through here, where the item now has nothing to replay by and the id
// goes with it.
function carriesBlob(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}
