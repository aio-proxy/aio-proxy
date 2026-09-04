import { isPlainObject } from 'es-toolkit/predicate';

import { validThoughtSignature } from '../../../protocol/signatures';
import { asArray, asRecord } from '../payload-shape';

const SKIP = 'skip_thought_signature_validator';

export function applyGeminiSkipThoughtSignature(
  body: Readonly<Record<string, unknown>>,
  modelId: string,
): Record<string, unknown> {
  if (!modelId.startsWith('gemini-')) return body;
  const contents = asArray(Reflect.get(body, 'contents'));
  if (contents.length === 0) return body;
  let index = -1;
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const item = asRecord(contents[i]);
    if (item !== undefined && Reflect.get(item, 'role') === 'model') {
      index = i;
      break;
    }
  }
  if (index < 0) return body;
  const turn = asRecord(contents[index]);
  if (turn === undefined) return body;
  const currentParts = asArray(Reflect.get(turn, 'parts'));
  if (currentParts.length === 0) return body;

  let firstCall = true;
  let changed = false;
  const parts = currentParts.map((part) => {
    const record = asRecord(part);
    if (record === undefined || !isPlainObject(Reflect.get(record, 'functionCall'))) return part;
    if (!firstCall) return part;
    firstCall = false;
    if (validThoughtSignature(modelId, Reflect.get(record, 'thoughtSignature'))) return part;
    changed = true;
    return { ...record, thoughtSignature: SKIP };
  });
  if (!changed) return body;
  const next = [...contents];
  next[index] = { ...turn, parts };
  return { ...body, contents: next };
}
