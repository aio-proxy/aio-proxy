// Multipart carries only text, so numeric form fields arrive as strings.
//
// `Number` is too permissive for wire input: it decodes `''` and `' '` as 0, so a
// `curl -F 'temperature='` would be read as an explicit 0 rather than "not sent",
// and it accepts non-decimal spellings (`0x10`, `0b11`) that no OpenAI client emits.
// Empty means absent; anything that is not a decimal literal becomes NaN so the
// caller's schema rejects it instead of accepting a value the client never wrote.
const DECIMAL_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu;

export function multipartFieldNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!DECIMAL_LITERAL.test(trimmed)) return Number.NaN;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
