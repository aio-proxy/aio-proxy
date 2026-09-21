import { isPlainObject } from 'es-toolkit/predicate';

// 抓包事件全部走 debug 级；非 debug 时文件里根本没有它们。
const WIRE_EVENTS = new Set([
  'request.inbound_snapshot',
  'request.upstream_snapshot',
  'request.upstream_result',
  'request.body_chunk',
  'request.body_terminal',
]);

/** 与 `keepChunk` 同一套 1 MiB 字符预算；超长行先按这个裁 `text` 再 `JSON.parse`。 */
const MAX_BODY_TEXT = 1_048_576;
/** 时间戳 / logger / 字段名的余量。超过就不再整行 parse，避免 `message` 再复制一份正文。 */
export const MAX_PARSE_LINE = MAX_BODY_TEXT + 16_384;

export type WireEvent = Readonly<Record<string, unknown>>;

/**
 * 一行 `jsonLinesFormatter` 输出里的抓包事件属性，不是这次请求的就返回 `undefined`。
 * 写日志的进程随时可能被 kill，末行可能是半条 JSON，所以解析失败只跳过这一行。
 */
export function wireEventFromLine(line: string, requestId: string): WireEvent | undefined {
  if (line.trim() === '') return undefined;
  // 别人的超长分块连 parse 都不做：`jsonLinesFormatter` 把正文写进 message 和 properties 各一份。
  if (line.length > MAX_PARSE_LINE && !line.includes(requestId)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.length > MAX_PARSE_LINE ? propertiesOnlyJson(line) : line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const properties = parsed['properties'];
  if (!isPlainObject(properties)) return undefined;
  if (properties['requestId'] !== requestId) return undefined;
  return typeof properties['event'] === 'string' && WIRE_EVENTS.has(properties['event']) ? properties : undefined;
}

/**
 * 只留 `properties`，并把 `text` 裁到预算 + 1：parse 不再分配整段正文，多出的那一个
 * 字符让 `keepChunk` 自己标 `truncated`。
 *
 * `jsonLinesFormatter` 行末是 `,"properties":{...}}`，多出来的 `}` 属于外层记录。
 */
function propertiesOnlyJson(line: string): string {
  const key = '"properties":';
  const at = line.lastIndexOf(key);
  if (at < 0) throw new SyntaxError('wire line missing properties');
  let properties = line.slice(at + key.length);
  if (properties.endsWith('}')) properties = properties.slice(0, -1);
  const textKey = '"text":"';
  const textAt = properties.lastIndexOf(textKey);
  if (textAt < 0) return `{"properties":${properties}}`;
  const textStart = textAt + textKey.length;
  const cut = cutJsonString(properties, textStart, MAX_BODY_TEXT + 1);
  if (cut === undefined) return `{"properties":${properties}}`;
  return `{"properties":${properties.slice(0, textStart)}${cut}}}`;
}

/**
 * 按**解码后**的字符数裁 JSON 字符串。`\n` 在行里占两个字符，按行长裁会只留下一半正文，
 * 而且 `keepChunk` 看不到超预算、标不出 truncated。切在 `\\uXXXX` 中间会整段 parse 失败。
 *
 * 返回已闭合的字符串字面量（含结尾引号）；整段装得下则 `undefined`。
 */
function cutJsonString(source: string, start: number, maxDecoded: number): string | undefined {
  let index = start;
  let decoded = 0;
  while (index < source.length) {
    const current = source[index];
    if (current === '"') return undefined;
    if (decoded >= maxDecoded) return `${source.slice(start, index)}"`;
    if (current === '\\') {
      const next = source[index + 1];
      if (next === undefined) throw new SyntaxError('unterminated escape');
      if (next === 'u') {
        if (index + 5 >= source.length) throw new SyntaxError('unterminated unicode escape');
        index += 6;
      } else {
        index += 2;
      }
    } else {
      index += 1;
    }
    decoded += 1;
  }
  throw new SyntaxError('unterminated string');
}

export function stringField(event: WireEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function numberField(event: WireEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function headersField(event: WireEvent, key: string): Readonly<Record<string, string>> | undefined {
  const value = event[key];
  if (!isPlainObject(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, header]) => (typeof header === 'string' ? [[name, header]] : [])),
  );
}
