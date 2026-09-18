import type { DashboardTraceWireHop } from '@aio-proxy/types';
import { sortBy } from 'es-toolkit/array';

import { headersField, numberField, stringField, type WireEvent } from './parse-line';

type BodyOutcome = 'complete' | 'cancelled' | 'error';

type BodyDraft = {
  readonly chunks: { readonly sequence: number; readonly text: string }[];
  byteLength?: number;
  outcome?: BodyOutcome;
};

type HopDraft = {
  readonly id: string;
  readonly kind: 'inbound' | 'attempt';
  attemptIndex?: number;
  providerId?: string;
  modelId?: string;
  method?: string;
  url?: string;
  requestHeaders?: Readonly<Record<string, string>>;
  requestBody?: BodyDraft;
  statusCode?: number;
  errorType?: string;
  durationMs?: number;
  responseHeaders?: Readonly<Record<string, string>>;
  responseBody?: BodyDraft;
};

const BODY_OUTCOMES = new Set<string>(['complete', 'cancelled', 'error']);
const INBOUND_HOP_ID = 'inbound';

/** 事件流 -> 逐跳视图：`inbound` 在前，attempt 按 `attemptIndex` 升序。 */
export function buildHops(events: readonly WireEvent[]): DashboardTraceWireHop[] {
  const drafts = new Map<string, HopDraft>();
  for (const event of events) applyEvent(drafts, event);
  const ordered = sortBy(
    [...drafts.values()],
    [(draft) => (draft.kind === 'inbound' ? 0 : 1), (draft) => draft.attemptIndex ?? 0],
  );
  return ordered.map(finalizeHop);
}

function applyEvent(drafts: Map<string, HopDraft>, event: WireEvent): void {
  const eventName = event['event'];
  if (eventName === 'request.inbound_snapshot') {
    const hop = inboundHop(drafts);
    hop.method = stringField(event, 'method');
    hop.url = stringField(event, 'url');
    hop.requestHeaders = headersField(event, 'headers');
    return;
  }
  if (eventName === 'request.upstream_snapshot') {
    const hop = attemptHop(drafts, event);
    if (hop === undefined) return;
    hop.method = stringField(event, 'method');
    hop.url = stringField(event, 'url');
    hop.requestHeaders = headersField(event, 'headers');
    return;
  }
  if (eventName === 'request.upstream_result') {
    const hop = attemptHop(drafts, event);
    if (hop === undefined) return;
    hop.durationMs = numberField(event, 'durationMs');
    hop.statusCode = numberField(event, 'statusCode');
    hop.responseHeaders = headersField(event, 'headers');
    hop.errorType = stringField(event, 'errorType');
    return;
  }
  // direction 先判：不认识的方向连 hop 都不该建，否则会凭空多出一个空跳。
  const direction = stringField(event, 'direction');
  if (direction !== 'inbound' && direction !== 'upstream_request' && direction !== 'upstream_response') return;
  const hop = direction === 'inbound' ? inboundHop(drafts) : attemptHop(drafts, event);
  if (hop === undefined) return;
  if (direction === 'upstream_response') {
    hop.responseBody = applyBodyEvent(hop.responseBody, event);
    return;
  }
  hop.requestBody = applyBodyEvent(hop.requestBody, event);
}

function applyBodyEvent(body: BodyDraft | undefined, event: WireEvent): BodyDraft {
  const draft = body ?? { chunks: [] };
  if (event['event'] === 'request.body_chunk') {
    const text = event['text'];
    if (typeof text === 'string') draft.chunks.push({ sequence: numberField(event, 'sequence') ?? 0, text });
    return draft;
  }
  draft.byteLength = numberField(event, 'byteLength');
  const outcome = stringField(event, 'outcome');
  if (outcome !== undefined && BODY_OUTCOMES.has(outcome)) draft.outcome = outcome as BodyOutcome;
  return draft;
}

function inboundHop(drafts: Map<string, HopDraft>): HopDraft {
  const existing = drafts.get(INBOUND_HOP_ID);
  if (existing !== undefined) return existing;
  const created: HopDraft = { id: INBOUND_HOP_ID, kind: 'inbound' };
  drafts.set(INBOUND_HOP_ID, created);
  return created;
}

function attemptHop(drafts: Map<string, HopDraft>, event: WireEvent): HopDraft | undefined {
  const attemptIndex = numberField(event, 'attemptIndex');
  // attemptIndex 是这一跳的唯一身份；没有它就无处归类，只能丢掉这一行。
  if (attemptIndex === undefined) return undefined;
  const id = `attempt-${attemptIndex}`;
  const hop = drafts.get(id) ?? { id, kind: 'attempt' as const, attemptIndex };
  hop.providerId ??= stringField(event, 'providerId');
  hop.modelId ??= stringField(event, 'modelId');
  drafts.set(id, hop);
  return hop;
}

function finalizeHop(draft: HopDraft): DashboardTraceWireHop {
  const request = defined({
    method: draft.method,
    url: draft.url,
    headers: draft.requestHeaders,
    body: finalizeBody(draft.requestBody),
  });
  const response = defined({
    statusCode: draft.statusCode,
    errorType: draft.errorType,
    durationMs: draft.durationMs,
    headers: draft.responseHeaders,
    body: finalizeBody(draft.responseBody),
  });
  return {
    id: draft.id,
    kind: draft.kind,
    ...defined({ attemptIndex: draft.attemptIndex, providerId: draft.providerId, modelId: draft.modelId }),
    ...(request === undefined ? {} : { request }),
    ...(response === undefined ? {} : { response }),
  };
}

/**
 * 单跳单方向保留的 body 上限。抓包是诊断视图，不是下载通道：一个流式大 body 原样
 * 拼出来能让代理进程多吃几百 MB，再把同样大的 JSON 推给浏览器 —— 而代理本身还在服务
 * 线上流量。超过就裁，并标 `truncated` 让面板说明白。`byteLength` 仍报日志里的真实大小。
 */
const MAX_BODY_TEXT = 1_048_576;

function finalizeBody(body: BodyDraft | undefined): BodyView {
  if (body === undefined) return undefined;
  let text = '';
  let truncated = false;
  for (const chunk of sortBy(body.chunks, [(item) => item.sequence])) {
    const room = MAX_BODY_TEXT - text.length;
    if (room <= 0) {
      truncated = true;
      break;
    }
    if (chunk.text.length > room) {
      // 先切再拼：单个分块自己就可能有上百 MB，整段接上去再 slice 等于白付一次内存。
      text += chunk.text.slice(0, room);
      truncated = true;
      break;
    }
    text += chunk.text;
  }
  return {
    text,
    ...(truncated ? { truncated: true } : {}),
    ...defined({ byteLength: body.byteLength, outcome: body.outcome }),
  };
}

type BodyView =
  | {
      readonly text: string;
      readonly byteLength?: number;
      readonly outcome?: BodyOutcome;
      readonly truncated?: boolean;
    }
  | undefined;

/** 去掉值为 `undefined` 的键，`.strict()` 的响应 schema 只接受真正存在的字段。 */
function defined<T extends object>(value: T): { [K in keyof T]?: NonNullable<T[K]> } | undefined {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as never);
}
