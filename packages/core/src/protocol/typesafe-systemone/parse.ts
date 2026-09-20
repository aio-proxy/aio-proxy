import { isPlainObject } from 'es-toolkit/predicate';

import type { EvaluationQuestion } from '../adapter';
import {
  readRequestText,
  REQUEST_BODY_LIMITS,
  type RequestBodyLimits,
  UnsupportedContentEncodingError,
} from '../request';

const NOUL_CRITERIA_KEYS = ['true', 'false'] as const;
const MAX_CHOICE_OPTIONS = 255;
const MIN_SCORE_LEVELS = 2;
const MAX_SCORE_LEVELS = 10;

// Nothing downstream of this parse can carry an arbitrarily deep body. Both onward
// transports hand it to recursive code we do not own -- `JSON.stringify` on the raw
// passthrough rewrite, and the AI SDK's own JSON validation on the model path -- and
// each blows the call stack well before `JSON.parse` runs out of input. So a body
// past some depth cannot be served at all; the only question is which answer the
// caller gets. Without a cap those throw a `RangeError` inside a candidate attempt,
// where the provider mapper turns it into a 502 that blames a healthy upstream and
// writes a cooldown against it, letting one small request degrade the candidate pool.
//
// This cap is deliberately not tuned to those thresholds. It sits more than an order
// of magnitude below the lowest of them, so a dependency bump that lowers one cannot
// invalidate it, and it is still far above anything real: authored evaluation `state`
// and `instructions` nest tens of levels at most. It therefore rejects only bodies
// that were going to fail downstream anyway, and turns that failure into an honest
// protocol-shaped 400 naming the caller's own body.
const MAX_NESTING_DEPTH = 512;

export class SystemOneParseError extends Error {}

export type SystemOneRequest = {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Readonly<Record<string, EvaluationQuestion>>;
  readonly body: Readonly<Record<string, unknown>>;
};

const reject = (message: string): never => {
  throw new SystemOneParseError(message);
};

// The same shape ai@7.0.107 `isInput()` accepts: string, array, or plain object.
const isInputValue = (value: unknown): boolean =>
  typeof value === 'string' || Array.isArray(value) || isPlainObject(value);

// JSON has no Infinity literal, but `JSON.parse('1e400')` yields Infinity.
//
// One pass enforces both the non-finite ban and `MAX_NESTING_DEPTH`: the walk already
// visits every node, so the cap costs one integer per pending entry rather than a
// second traversal. Returns the rejection message, or `undefined` when the body is
// acceptable.
//
// The walk is iterative over an explicit stack because recursing once per level
// overflows the call stack on a deeply nested body, and a `RangeError` is not a
// `SystemOneParseError`: the pipeline would answer a 5xx for a body this endpoint
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
const scanBody = (root: unknown): string | undefined => {
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

// A media type other than `application/json` is 415, not 400: the caller sent a
// representation this endpoint cannot accept rather than malformed JSON, and the
// client has to be able to tell those apart. `UnsupportedContentEncodingError` is
// the rejection the pipeline already answers with `errors.unsupportedContentEncoding`,
// so it escapes this parse unwrapped exactly as the encoding check does; a
// `SystemOneParseError` here would be downgraded to a 400 blaming the body.
const assertMediaType = (raw: Request): void => {
  const header = raw.headers.get('content-type');
  if (header === null) return;
  const mediaType = header.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') throw new UnsupportedContentEncodingError(mediaType ?? '');
};

const parseQuestion = (id: string, value: unknown): EvaluationQuestion => {
  if (!isPlainObject(value)) return reject(`questions.${id} must be an object`);
  if (!isInputValue(value['instructions'])) {
    return reject(`questions.${id}.instructions must be a string, object, or array`);
  }
  const criteria = value['criteria'];
  if (value['type'] === 'noul') {
    if (criteria !== undefined) {
      if (!isPlainObject(criteria)) return reject(`questions.${id}.criteria must be an object`);
      // Only the two declared labels are typed; every other key is preserved untouched.
      for (const key of NOUL_CRITERIA_KEYS) {
        const label = criteria[key];
        if (label !== undefined && typeof label !== 'string') {
          reject(`questions.${id}.criteria.${key} must be a string`);
        }
      }
    }
    return value as unknown as EvaluationQuestion;
  }
  if (value['type'] === 'choice') {
    if (!isPlainObject(criteria)) return reject(`questions.${id}.criteria must be an option map`);
    const keys = Object.keys(criteria);
    if (keys.length === 0) reject(`questions.${id}.criteria must be nonempty`);
    if (keys.length > MAX_CHOICE_OPTIONS) {
      reject(`questions.${id}.criteria supports at most ${MAX_CHOICE_OPTIONS} options`);
    }
    for (const key of keys) {
      const description = criteria[key];
      if (description !== null && typeof description !== 'string') {
        reject(`questions.${id}.criteria.${key} must be a string or null`);
      }
    }
    return value as unknown as EvaluationQuestion;
  }
  if (value['type'] === 'score') {
    if (!Array.isArray(criteria)) return reject(`questions.${id}.criteria must be an array`);
    if (criteria.length < MIN_SCORE_LEVELS) {
      reject(`questions.${id}.criteria needs at least ${MIN_SCORE_LEVELS} levels`);
    }
    if (criteria.length > MAX_SCORE_LEVELS) {
      reject(`questions.${id}.criteria supports at most ${MAX_SCORE_LEVELS} levels`);
    }
    if (criteria.some((level) => typeof level !== 'string')) {
      reject(`questions.${id}.criteria levels must be strings`);
    }
    return value as unknown as EvaluationQuestion;
  }
  return reject(`questions.${id}.type must be noul, choice, or score`);
};

export async function parseSystemOneBody(
  raw: Request,
  limits: RequestBodyLimits = REQUEST_BODY_LIMITS,
): Promise<SystemOneRequest> {
  assertMediaType(raw);

  // Read outside the JSON try on purpose: `readRequestText` is what enforces the
  // streamed size limits and rejects unknown content encodings, and the pipeline
  // maps those rejections to 413/415. Wrapping them in SystemOneParseError would
  // downgrade both to a 400 that blames the caller's JSON.
  const text = await readRequestText(raw, limits);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return reject('Request body is not valid JSON');
  }
  if (!isPlainObject(body)) return reject('Request body must be a JSON object');
  const unacceptable = scanBody(body);
  if (unacceptable !== undefined) reject(unacceptable);

  const { model, state, questions } = body;
  if (typeof model !== 'string' || model.length === 0) reject('model must be a nonempty string');
  if (!('state' in body)) reject('state is required');
  if (!isInputValue(state)) reject('state must be a string, object, or array');
  if (!isPlainObject(questions)) return reject('questions must be a nonempty question map');
  const ids = Object.keys(questions);
  if (ids.length === 0) reject('questions must declare at least one question');

  const parsed = Object.fromEntries(ids.map((id) => [id, parseQuestion(id, questions[id])]));
  return { model: model as string, state, questions: parsed, body };
}
