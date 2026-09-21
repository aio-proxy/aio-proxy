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
/** 最坏 `\uXXXX`：一个解码字符 6 个源字符。properties 段按这个封顶，message 仍然先丢掉。 */
export const MAX_PROPERTIES_CARRY = (MAX_BODY_TEXT + 1) * 6 + 16_384;
/** `jsonLinesFormatter` 行末字段。扫描时只留从这里起的一段，丢掉前面重复的 message。 */
export const PROPERTIES_KEY = '"properties":';

/**
 * 外层 logtape `properties`。header 名也可以叫 properties，lastIndexOf 会切到嵌套键上。
 * 扫过字符串字面量，只认深度 1 的键；已经切下来的 `"properties":{...` 就在开头。
 */
export function indexOfOuterProperties(source: string, end = source.length): number {
  const limit = Math.min(end, source.length);
  if (limit >= PROPERTIES_KEY.length && source.startsWith(PROPERTIES_KEY)) return 0;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < limit; i += 1) {
    const current = source[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (current === '\\') {
        escape = true;
        continue;
      }
      if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      if (depth === 1 && i + PROPERTIES_KEY.length <= limit && source.startsWith(PROPERTIES_KEY, i)) return i;
      inString = true;
      continue;
    }
    if (current === '{') depth += 1;
    else if (current === '}') depth -= 1;
  }
  // 超长行会先丢掉开头的 `{`，深度对不上。嵌套键在外层后面，第一个就是 logtape 字段。
  const at = source.indexOf(PROPERTIES_KEY);
  return at >= 0 && at < limit ? at : -1;
}

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
    parsed = JSON.parse(
      line.length > MAX_PARSE_LINE || line.startsWith(PROPERTIES_KEY) ? propertiesOnlyJson(line) : line,
    );
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
  const at = indexOfOuterProperties(line);
  if (at < 0) throw new SyntaxError('wire line missing properties');
  let properties = line.slice(at + PROPERTIES_KEY.length);
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
      // 边读边裁时行还没写完：半截转义丢掉，闭合已有的前缀，别整行 parse 失败。
      if (next === undefined) return `${source.slice(start, index)}"`;
      if (next === 'u') {
        if (index + 5 >= source.length) return `${source.slice(start, index)}"`;
        index += 6;
      } else {
        index += 2;
      }
    } else {
      index += 1;
    }
    decoded += 1;
  }
  return `${source.slice(start, index)}"`;
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
