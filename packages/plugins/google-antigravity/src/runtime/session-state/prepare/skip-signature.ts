import { isPlainObject } from 'es-toolkit/predicate';

import { validThoughtSignature } from '../../../protocol/signatures';

const SKIP = 'skip_thought_signature_validator';

export function applyGeminiSkipThoughtSignature(
  body: Readonly<Record<string, unknown>>,
  modelId: string,
): Record<string, unknown> {
  if (!modelId.startsWith('gemini-')) return body;
  const contents = Array.isArray(body.contents) ? [...body.contents] : undefined;
  if (contents === undefined) return body;
  const index = contents.findLastIndex((item) => isPlainObject(item) && item.role === 'model');
  if (index < 0) return body;
  const turn = contents[index];
  if (!isPlainObject(turn) || !Array.isArray(turn.parts)) return body;

  let firstCall = true;
  let changed = false;
  const parts = turn.parts.map((part) => {
    if (!isPlainObject(part) || !isPlainObject(part.functionCall)) return part;
    if (!firstCall) return part;
    firstCall = false;
    if (validThoughtSignature(modelId, part.thoughtSignature)) return part;
    changed = true;
    return { ...part, thoughtSignature: SKIP };
  });
  if (!changed) return body;
  const next = [...contents];
  next[index] = { ...turn, parts };
  return { ...body, contents: next };
}
