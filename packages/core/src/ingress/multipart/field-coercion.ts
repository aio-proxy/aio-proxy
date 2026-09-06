// Multipart carries only text, so numeric and boolean form fields arrive as strings.
//
// `Number` is too permissive for wire input: it decodes `''` and `' '` as 0, so a
// `curl -F 'temperature='` would be read as an explicit 0 rather than "not sent",
// and it accepts non-decimal spellings (`0x10`, `0b11`) that no OpenAI client emits.
// Empty means absent; anything that is not a decimal literal becomes NaN so the
// caller's schema rejects it instead of accepting a value the client never wrote.
//
// The fraction is `\d+(?:\.\d*)?`, never `\d+\.?\d*`: the latter lets a run of digits
// split ambiguously between the two quantifiers, so one illegal trailing character
// forces exponential backtracking. A 200 KB `temperature` field is well inside the
// 1 MiB non-file budget, so that shape is a remotely reachable event-loop DoS. The
// mandatory `.` anchor makes each position match one way only, hence linear.
const DECIMAL_LITERAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

export function multipartFieldNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!DECIMAL_LITERAL.test(trimmed)) return Number.NaN;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

// Same "empty means absent" rule as `multipartFieldNumber`: an empty part must never
// become `false`, or a `curl -F 'stream='` would read as an explicit opt-out. A value
// that is neither boolean literal is returned verbatim so the caller's schema reports
// what the client actually sent instead of coercing it to false.
export function multipartFieldBoolean(value: string | undefined): boolean | string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return value;
}
