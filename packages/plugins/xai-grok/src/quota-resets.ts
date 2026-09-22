import type { AccountContext, OAuthQuotaResetCredit, OAuthQuotaResetCredits } from '@aio-proxy/plugin-sdk';
import { create, fromBinary, toBinary, type DescMessage } from '@bufbuild/protobuf';
import type { Timestamp } from '@bufbuild/protobuf/wkt';

import {
  ConsumerGetRemainingResetsReqSchema,
  ConsumerGetRemainingResetsRespSchema,
  ConsumerRedeemResetReqSchema,
  ConsumerRedeemResetRespSchema,
  ConsumerUiSvc,
} from './billing/consumer-ui_pb';
import { createXAIGrokCLIHeaders } from './cli-headers/index';
import { currentXAIGrokCredential, type XAIGrokOAuthOptions } from './oauth';
import type { XAIGrokCredential } from './schema';

const GROK_ORIGIN = 'https://grok.com';
const RESET_TIMEOUT_MS = 2_000;
const MAX_RESET_CREDITS = 64;

type Fetcher = NonNullable<XAIGrokOAuthOptions['fetch']>;

const remainingResetsUrl = rpcUrl(ConsumerUiSvc.method.getRemainingResets.name);
const redeemResetUrl = rpcUrl(ConsumerUiSvc.method.redeemReset.name);

/**
 * Banked usage-limit resets live on grok.com ConsumerUiSvc, not in the CLI billing JSON.
 * A miss here must not fail the usage read: `undefined` means the inventory could not be read,
 * which is distinct from zero.
 */
export async function readXAIGrokResetCredits(
  fetcher: Fetcher,
  headers: Headers,
  signal: AbortSignal,
): Promise<OAuthQuotaResetCredits | undefined> {
  try {
    const response = await postGrpc(
      fetcher,
      remainingResetsUrl,
      headers,
      frame(toBinary(ConsumerGetRemainingResetsReqSchema, create(ConsumerGetRemainingResetsReqSchema))),
      signal,
    );
    if (!response.ok) return undefined;
    return creditsFrom(await response.arrayBuffer(), response.headers.get('grpc-status'), Date.now());
  } catch {
    return undefined;
  }
}

/** Redeems the soonest-expiring banked reset. The framework only calls this after a credit was listed. */
export async function resetXAIGrokQuota(
  context: AccountContext<XAIGrokCredential, Record<string, never>>,
  options: XAIGrokOAuthOptions = {},
): Promise<void> {
  const credential = await currentXAIGrokCredential(context.credentials, { ...options, signal: context.signal });
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = grpcHeaders(credential);
  const credits = await readXAIGrokResetCredits(fetcher, headers, context.signal);
  const tokenId = soonest(credits);
  if (tokenId === undefined) throw new Error('xAI Grok reset credit is unavailable');
  const response = await postGrpc(
    fetcher,
    redeemResetUrl,
    headers,
    frame(toBinary(ConsumerRedeemResetReqSchema, create(ConsumerRedeemResetReqSchema, { tokenId }))),
    context.signal,
  );
  if (!response.ok) throw new Error(`xAI Grok reset failed (${response.status})`);
  const decoded = decodeGrpc(new Uint8Array(await response.arrayBuffer()), response.headers.get('grpc-status'));
  if (decoded?.status !== '0' || !payloadsMatch(ConsumerRedeemResetRespSchema, decoded.payloads)) {
    throw new Error('xAI Grok reset failed');
  }
}

function rpcUrl(method: string): string {
  return `${GROK_ORIGIN}/${ConsumerUiSvc.typeName}/${method}`;
}

function grpcHeaders(credential: XAIGrokCredential): Headers {
  const headers = createXAIGrokCLIHeaders(credential);
  if (credential.subject !== undefined) headers.set('x-userid', credential.subject);
  return headers;
}

function soonest(credits: OAuthQuotaResetCredits | undefined): string | undefined {
  if (credits === undefined || credits.availableCount <= 0 || credits.items === undefined) return undefined;
  return [...credits.items].sort(
    (left, right) => (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY),
  )[0]?.id;
}

async function postGrpc(
  fetcher: Fetcher,
  url: string,
  headers: Headers,
  body: Uint8Array,
  signal: AbortSignal,
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set('accept', 'application/grpc-web+proto');
  requestHeaders.set('content-type', 'application/grpc-web+proto');
  requestHeaders.set('x-grpc-web', '1');
  return fetcher(url, {
    method: 'POST',
    headers: requestHeaders,
    body: Uint8Array.from(body).buffer,
    signal: AbortSignal.any([signal, AbortSignal.timeout(RESET_TIMEOUT_MS)]),
  });
}

function creditsFrom(body: ArrayBuffer, headerStatus: string | null, now: number): OAuthQuotaResetCredits | undefined {
  const decoded = decodeGrpc(new Uint8Array(body), headerStatus);
  if (decoded?.status !== '0') return undefined;
  const items = tokensFrom(decoded.payloads, now);
  if (items === undefined) return undefined;
  return { availableCount: items.length, ...(items.length === 0 ? {} : { items }) };
}

function tokensFrom(payloads: readonly Uint8Array[], now: number): readonly OAuthQuotaResetCredit[] | undefined {
  const items: OAuthQuotaResetCredit[] = [];
  const seen = new Set<string>();
  for (const payload of payloads) {
    let message;
    try {
      message = fromBinary(ConsumerGetRemainingResetsRespSchema, payload);
    } catch {
      return undefined;
    }
    for (const token of message.tokens) {
      const id = token.tokenId.trim();
      if (id === '') continue;
      const expiresAt = timestampMs(token.validityEnd);
      if (expiresAt !== undefined && expiresAt <= now) continue;
      if (seen.has(id) || items.length >= MAX_RESET_CREDITS) continue;
      seen.add(id);
      items.push({ id, ...(expiresAt === undefined ? {} : { expiresAt }) });
    }
  }
  return items.sort(
    (left, right) => (left.expiresAt ?? Number.POSITIVE_INFINITY) - (right.expiresAt ?? Number.POSITIVE_INFINITY),
  );
}

function payloadsMatch<Desc extends DescMessage>(schema: Desc, payloads: readonly Uint8Array[]): boolean {
  return payloads.every((payload) => {
    try {
      fromBinary(schema, payload);
      return true;
    } catch {
      return false;
    }
  });
}

function timestampMs(timestamp: Timestamp | undefined): number | undefined {
  if (timestamp === undefined) return undefined;
  const millis = Number(timestamp.seconds) * 1000 + Math.trunc(timestamp.nanos / 1_000_000);
  return Number.isSafeInteger(millis) ? millis : undefined;
}

function decodeGrpc(
  bytes: Uint8Array,
  headerStatus: string | null,
): { readonly status: string | undefined; readonly payloads: readonly Uint8Array[] } | undefined {
  const payloads: Uint8Array[] = [];
  let status = headerStatus ?? undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 5 > bytes.length) return undefined;
    const flags = bytes[offset] ?? 0;
    const length = view.getUint32(offset + 1);
    offset += 5;
    if (offset + length > bytes.length) return undefined;
    const chunk = bytes.subarray(offset, offset + length);
    offset += length;
    if ((flags & 0x80) !== 0) {
      const trailer = new TextDecoder().decode(chunk).match(/grpc-status:\s*(\d+)/iu);
      if (trailer?.[1] !== undefined) status = trailer[1];
    } else {
      payloads.push(chunk);
    }
  }
  return { status, payloads };
}

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}
