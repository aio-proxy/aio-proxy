import type { DashboardTraceWireHop } from '@aio-proxy/types';
import { sortBy } from 'es-toolkit/array';

import { headersField, numberField, stringField, type WireEvent } from './parse-line';

type BodyOutcome = 'complete' | 'cancelled' | 'error';

export type BodyDraft = {
  /** 按 `sequence` 升序、已经裁到预算以内的分块；`kept` 是它们的字符数之和。 */
  readonly chunks: { readonly sequence: number; text: string }[];
  kept: number;
  truncated?: boolean;
  byteLength?: number;
  outcome?: BodyOutcome;
};

export type HopDraft = {
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

/** 逐跳草稿；读取侧一行一行往里灌，读完再 `finalizeHops`。 */
export type HopDrafts = Map<string, HopDraft>;

const BODY_OUTCOMES = new Set<string>(['complete', 'cancelled', 'error']);
const INBOUND_HOP_ID = 'inbound';

export function createHopDrafts(): HopDrafts {
  return new Map();
}

/** 草稿 -> 逐跳视图：`inbound` 在前，attempt 按 `attemptIndex` 升序。 */
export function finalizeHops(drafts: HopDrafts): DashboardTraceWireHop[] {
  const ordered = sortBy(
    [...drafts.values()],
    [(draft) => (draft.kind === 'inbound' ? 0 : 1), (draft) => draft.attemptIndex ?? 0],
  );
  return ordered.map(finalizeHop);
}

export function applyWireEvent(drafts: HopDrafts, event: WireEvent): void {
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
  const draft = body ?? { chunks: [], kept: 0 };
  if (event['event'] === 'request.body_chunk') {
    const text = event['text'];
    if (typeof text === 'string') keepChunk(draft, numberField(event, 'sequence') ?? 0, text);
    return draft;
  }
  draft.byteLength = numberField(event, 'byteLength');
  const outcome = stringField(event, 'outcome');
  if (outcome !== undefined && BODY_OUTCOMES.has(outcome)) draft.outcome = outcome as BodyOutcome;
  return draft;
}

/**
 * 单跳单方向保留的 body 上限。抓包是诊断视图，不是下载通道：一个流式大 body 原样
 * 拼出来能让代理进程多吃几百 MB，再把同样大的 JSON 推给浏览器 —— 而代理本身还在服务
 * 线上流量。超过就裁，并标 `truncated` 让面板说明白。`byteLength` 仍报日志里的真实大小。
 */
const MAX_BODY_TEXT = 1_048_576;

/**
 * 预算在**读取时**就兑现：超出上限的分块当场丢掉，事件对象随即可回收，进程峰值由上限
 * 决定而不是由日志体积决定。放到 finalize 再裁的话，整个 body 早就全在内存里了。
 *
 * 日志是追加写的，同方向的分块几乎总是按 `sequence` 到达；跨零点读两个文件时才可能乱序，
 * 所以插入保持有序、裁剪一律从尾巴上来 —— 留下的永远是最前面那一段。
 */
function keepChunk(draft: BodyDraft, sequence: number, text: string): void {
  const last = draft.chunks.at(-1);
  if (draft.kept >= MAX_BODY_TEXT && (last === undefined || sequence >= last.sequence)) {
    // 顺序到达且预算已满：连存都不存，省下 splice 再 pop 的来回。
    draft.truncated = true;
    return;
  }
  const at =
    last !== undefined && sequence >= last.sequence ? draft.chunks.length : insertionIndex(draft.chunks, sequence);
  draft.chunks.splice(at, 0, { sequence, text });
  draft.kept += text.length;
  while (draft.kept > MAX_BODY_TEXT) {
    const tail = draft.chunks.at(-1);
    if (tail === undefined) break;
    const excess = draft.kept - MAX_BODY_TEXT;
    if (excess >= tail.text.length) {
      draft.chunks.pop();
      draft.kept -= tail.text.length;
    } else {
      tail.text = tail.text.slice(0, tail.text.length - excess);
      draft.kept = MAX_BODY_TEXT;
    }
    draft.truncated = true;
  }
}

function insertionIndex(chunks: readonly { readonly sequence: number }[], sequence: number): number {
  let low = 0;
  let high = chunks.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((chunks[mid]?.sequence ?? 0) <= sequence) low = mid + 1;
    else high = mid;
  }
  return low;
}

function inboundHop(drafts: HopDrafts): HopDraft {
  const existing = drafts.get(INBOUND_HOP_ID);
  if (existing !== undefined) return existing;
  const created: HopDraft = { id: INBOUND_HOP_ID, kind: 'inbound' };
  drafts.set(INBOUND_HOP_ID, created);
  return created;
}

function attemptHop(drafts: HopDrafts, event: WireEvent): HopDraft | undefined {
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

function finalizeBody(body: BodyDraft | undefined): BodyView {
  if (body === undefined) return undefined;
  const text = body.chunks.map((chunk) => chunk.text).join('');
  return {
    text,
    ...(body.truncated === true ? { truncated: true } : {}),
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
