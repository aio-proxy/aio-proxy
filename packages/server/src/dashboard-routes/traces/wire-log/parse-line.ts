import { isPlainObject } from 'es-toolkit/predicate';

// 抓包事件全部走 debug 级；非 debug 时文件里根本没有它们。
const WIRE_EVENTS = new Set([
  'request.inbound_snapshot',
  'request.upstream_snapshot',
  'request.upstream_result',
  'request.body_chunk',
  'request.body_terminal',
]);

export type WireEvent = Readonly<Record<string, unknown>>;

/**
 * 一行 `jsonLinesFormatter` 输出里的抓包事件属性，不是这次请求的就返回 `undefined`。
 * 写日志的进程随时可能被 kill，末行可能是半条 JSON，所以解析失败只跳过这一行。
 */
export function wireEventFromLine(line: string, requestId: string): WireEvent | undefined {
  if (line.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  const properties = parsed['properties'];
  if (!isPlainObject(properties)) return undefined;
  if (properties['requestId'] !== requestId) return undefined;
  return typeof properties['event'] === 'string' && WIRE_EVENTS.has(properties['event']) ? properties : undefined;
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
