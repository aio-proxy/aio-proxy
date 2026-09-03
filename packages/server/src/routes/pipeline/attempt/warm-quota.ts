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
