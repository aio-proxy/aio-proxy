import { uniq } from 'es-toolkit/array';

const MANUAL_MODEL_SPLIT = /[\s,]+/u;

export const parseManualModelIds = (raw: string): readonly string[] =>
  raw
    .split(MANUAL_MODEL_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part !== '');

/**
 * New ids go to the front, in typed order. An id already on the whitelist stays
 * where it is — the caller already treats membership as enabled.
 */
export const addManualModels = (selected: readonly string[], incoming: readonly string[]): readonly string[] => {
  const known = new Set(selected);
  const prepended = uniq(incoming).filter((id) => !known.has(id));
  return prepended.length === 0 ? selected : [...prepended, ...selected];
};
