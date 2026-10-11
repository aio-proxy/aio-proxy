import { isPlainObject } from 'es-toolkit/predicate';

// Stay well below recursive serializers and SDK validators' stack limits.
const MAX_NESTING_DEPTH = 512;

// JSON has no Infinity literal, but `JSON.parse('1e400')` yields Infinity.
//
// One pass enforces both the non-finite ban and `MAX_NESTING_DEPTH`: the walk already
// visits every node, so the cap costs one integer per pending entry rather than a
// second traversal. Returns the rejection message, or `undefined` when the body is
// acceptable.
//
// The walk is iterative over an explicit stack because recursing once per level
// overflows the call stack on a deeply nested body, and a `RangeError` is not a
// protocol parse error: the pipeline would answer a 5xx for a body this endpoint
// should reject with a protocol-shaped 400. The cap alone would not save a recursive
// walk, because the overflow happens on the way down to it. Children are pushed in a
// loop rather than with `push(...children)`, which spreads through the argument stack
// and throws the same `RangeError` on a wide array; the cap is about depth, not
// breadth, and must not be mistaken for a defense against that. No cycle detection:
// `JSON.parse` cannot yield a self-referential value, so every node is reached once
// and the total work stays bounded by the already-enforced body size.
//
// `depth` counts containers entered on the path to a value, so the body object itself
// is 0 and the cap admits `MAX_NESTING_DEPTH` levels of nesting.
export const scanJsonBody = (root: unknown): string | undefined => {
  const pending: unknown[] = [root];
  const depths: number[] = [0];
  while (pending.length > 0) {
    const value = pending.pop();
    const depth = depths.pop() as number;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'Request body contains a non-finite number';
      continue;
    }
    const isArray = Array.isArray(value);
    if (!isArray && !isPlainObject(value)) continue;
    if (depth >= MAX_NESTING_DEPTH) {
      return `Request body is nested more than ${MAX_NESTING_DEPTH} levels deep`;
    }
    for (const item of isArray ? value : Object.values(value)) {
      pending.push(item);
      depths.push(depth + 1);
    }
  }
  return undefined;
};
