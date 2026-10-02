import { ProviderKind } from '@aio-proxy/types';

import type { ProviderRouteSource, RuntimeProviderInstance } from '../../../runtime';

/**
 * A `return` step also carries terminal failures (unsupported dispatch, mapped upstream errors), and
 * only a provider that actually served the request has spent quota worth re-reading.
 *
 * The warm waits for the response body to settle. A streamed attempt returns as soon as the `Response`
 * exists, long before upstream has accounted the tokens, so warming there would cache the pre-request
 * balance and then hold it behind the read cooldown. The response is already on its way out, so this
 * must never delay or fail it: the bytes pass through untouched and the warm is only a side effect.
 */
export function warmProviderQuota(
  source: ProviderRouteSource,
  provider: RuntimeProviderInstance,
  response: Response,
): Response {
  if (!response.ok || provider.kind !== ProviderKind.OAuth) return response;
  let warmed = false;
  // A cancelled or errored body still warms: whatever streamed before that point was already spent
  // upstream, so it is still worth re-reading.
  const warm = () => {
    if (warmed) return;
    warmed = true;
    source.warmProviderQuota?.(provider.id);
  };
  const body = response.body;
  if (body === null) {
    warm();
    return response;
  }
  return new Response(observeSettlement(body, warm), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

// A refusal may cut the cache's 5-minute read cooldown short, but no shorter than this, so a Provider
// that 429s every request for some other reason (a request-rate limit) costs at most one quota read a
// minute. A failed read keeps the original sample time, so leave its retry to the cache's cooldown.
const REFUSAL_REREAD_MIN_AGE_MS = 60_000;

/**
 * A 429 from a subscription is usually its quota running out, so re-read the quota to give selection
 * the snapshot it needs to skip the Provider next time — even when it never served a request since
 * start. A snapshot already in the cache says quota remained when it was sampled; the refusal
 * contradicts it, and a plain warm would sit behind the read cooldown while every request is refused,
 * so a non-stale snapshot over a minute old is re-read regardless of the cooldown. A failed read
 * leaves the snapshot stale, and its next read is left to the cooldown.
 */
export function warmQuotaOnRefusal(
  source: ProviderRouteSource,
  provider: RuntimeProviderInstance,
  status: number | undefined,
): void {
  if (status !== 429 || provider.kind !== ProviderKind.OAuth) return;
  const cached = source.quotaStatus?.(provider.id);
  if (
    cached?.kind === 'ready' &&
    !cached.entry.stale &&
    Date.now() - cached.entry.sampledAt >= REFUSAL_REREAD_MIN_AGE_MS
  ) {
    source.refreshProviderQuota?.(provider.id);
    return;
  }
  source.warmProviderQuota?.(provider.id);
}

// `highWaterMark: 0` keeps this a pass-through that never reads ahead of the client, so it cannot turn
// a slow consumer into buffered memory.
function observeSettlement(source: ReadableStream<Uint8Array>, onSettled: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          onSettled();
          controller.close();
        } catch (error) {
          onSettled();
          controller.error(error);
        }
      },
      async cancel(reason) {
        onSettled();
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
