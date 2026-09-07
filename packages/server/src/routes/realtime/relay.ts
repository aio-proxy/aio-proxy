import type { RealtimeStyle } from '@aio-proxy/plugin-sdk';
import type { WSContext, WSEvents, WSMessageReceive } from 'hono/ws';

import { logServerEvent } from '../../server-log';
import type { RealtimeAttachment } from './call-store';
import { INTERNAL_CLOSE_CODE, normalizedClose, SHUTDOWN_CLOSE_CODE } from './close-code';
import type { RealtimeRouteSource } from './source';

export const BACKPRESSURE_LIMIT = 1_048_576;

export type RelayInput = {
  readonly callId: string | undefined;
  readonly providerId: string;
  readonly model: string;
  readonly attachment: RealtimeAttachment | undefined;
  readonly style: RealtimeStyle;
  readonly upstream: WebSocket;
};

export type Teardown = (code: number, reason?: string, origin?: 'downstream' | 'upstream' | 'proxy') => void;

export type Relay = { readonly events: WSEvents; readonly teardown: Teardown };

/** Returns the teardown alongside the events so the caller can run the one teardown
 *  itself when the upgrade it was built for never happens. Private to
 *  `routes/realtime/`: `sideband.ts` is the only caller, and the relay owns the
 *  reservation from the moment it is built. */
export function createRelay(source: RealtimeRouteSource, input: RelayInput): Relay {
  const upstream = input.upstream;
  upstream.binaryType = 'arraybuffer';
  let downstream: WSContext | undefined;
  let opened = false;
  let torndown = false;
  /** The code `teardown` already normalized, kept for a downstream that opens after it ran.
   *  The reservation is taken up to a full dial deadline before the relay exists
   *  (`sideband.ts` reserves, then awaits `dial()`), so a shutdown or a 2xx hangup landing in
   *  that window tears this relay down with `1001`/`1000` the instant `onClose` is registered —
   *  before `onOpen`, while the upgrade still proceeds. Substituting `1011` there reported a
   *  call that ended normally as an internal error and turned a shutdown's `1001` into `1011`
   *  too; the spec's close-code table pins `1000` for a 2xx hangup over a live sideband and
   *  `1001` for shutdown. */
  let teardownCode: number | undefined;
  /** Releases this relay's shutdown registration. Only a relay with no attachment has one:
   *  a call-backed relay is already reachable from the store through its reservation. */
  let releaseShutdownHook: (() => void) | undefined;

  // One teardown, safe from either side's close, from shutdown, and from hangup.
  const teardown: Teardown = (code, reason, origin = 'proxy') => {
    if (torndown) return;
    torndown = true;
    // Normalized once and applied to BOTH directions. On the downstream -> upstream
    // leg this is load-bearing: the upstream is a client `WebSocket`, whose `close()`
    // throws `InvalidAccessError` on a reserved code and `SyntaxError` over 123 UTF-8
    // bytes, so an unnormalized forward would abort the frame entirely. On the
    // upstream -> downstream leg it only bounds what the proxy itself emits; see
    // `close-code.ts` for what Bun has already destroyed by the time a reason arrives.
    const normalized = normalizedClose(code, reason);
    teardownCode = normalized.code;
    closeQuietly(upstream, normalized.code, normalized.reason);
    try {
      downstream?.close(normalized.code, normalized.reason);
    } catch {}
    if (input.attachment !== undefined) source.realtimeCalls.release(input.attachment.token);
    // Unregistered here rather than only at shutdown, so a long-lived process does not
    // accumulate one retained closure per finished direct relay.
    releaseShutdownHook?.();
    // A sideband that never opened is a *failed attach*: the call is still live
    // upstream-side from the caller's point of view, so the record must survive for
    // the owner's next attempt, and no `sideband_closed` may be logged against a
    // sideband that was never opened.
    if (!opened) return;
    if (input.attachment !== undefined && input.callId !== undefined) {
      source.realtimeCalls.remove(input.callId);
    }
    logServerEvent(source.logger, {
      event: 'realtime.sideband_closed',
      callId: input.callId ?? '',
      providerId: input.providerId,
      model: input.model,
      style: input.style,
      closeCode: normalized.code,
      origin,
    });
  };

  if (input.attachment === undefined) {
    // A direct relay owns no call record, so the store's `entries` — the only thing the
    // server's shutdown walks — cannot reach it. Registered so `app.close()` closes this
    // socket with `1001` instead of leaving `server.stop(true)` to force-terminate it.
    const hook = source.realtimeCalls.trackShutdown((code) => teardown(code, undefined, 'proxy'));
    // `undefined` means shutdown already ran. Torn down at once rather than left live, for the
    // same reason `RealtimeAttachment.onClose` runs a late-registered teardown immediately: the
    // registration point is up to a full dial deadline after the request began, and merely
    // dropping the hook would leave the upstream socket with nothing to close it.
    if (hook === undefined) teardown(SHUTDOWN_CLOSE_CODE, undefined, 'proxy');
    else releaseShutdownHook = hook.release;
  }
  input.attachment?.onClose((code) => teardown(code, undefined, 'proxy'));

  upstream.addEventListener('message', (event: MessageEvent<string | ArrayBuffer>) => {
    if (downstream === undefined) {
      // Unreachable in Bun 1.4.2: `websocket.open` runs synchronously inside
      // `server.upgrade()`, in the same tick as the dial's resumption, and a
      // WebSocket event needs an event-loop turn — so there is no window in which
      // the upstream can speak before `onOpen`. The listener is still bound this
      // early on purpose: a Bun client `WebSocket` silently discards frames
      // delivered with no `message` listener, so binding late would trade a loud
      // failure for lost bytes. If the ordering ever changes, the relay fails
      // closed instead of dropping a frame.
      teardown(INTERNAL_CLOSE_CODE, undefined, 'upstream');
      return;
    }
    sendDownstream(downstream, event.data, teardown);
  });
  upstream.addEventListener('close', (event: CloseEvent) => teardown(event.code, event.reason, 'upstream'));
  // Bun always follows `error` with `close`, so the close handler is the single
  // teardown trigger and this listener only prevents an unhandled event.
  upstream.addEventListener('error', () => {});

  return {
    teardown,
    events: {
      onOpen(_event: Event, ws: WSContext) {
        downstream = ws;
        if (torndown) {
          try {
            // The already-normalized code, never a fresh `1011`: this branch is reached
            // whenever teardown ran before the upgrade landed, and the common way that
            // happens is a hangup or a shutdown during the pending dial. `?? INTERNAL_CLOSE_CODE`
            // is unreachable — `teardown` assigns before it can set `torndown` — and is the
            // fail-closed default rather than a non-null assertion.
            ws.close(teardownCode ?? INTERNAL_CLOSE_CODE);
          } catch {}
          return;
        }
        opened = true;
        logServerEvent(source.logger, {
          event: 'realtime.sideband_opened',
          callId: input.callId ?? '',
          providerId: input.providerId,
          model: input.model,
          style: input.style,
        });
      },
      onMessage(event: MessageEvent<WSMessageReceive>) {
        const data = event.data;
        // Hono's Bun adapter already normalized a binary frame to `message.buffer`,
        // an exclusive Buffer on Bun 1.4.2. Forward it as-is: copying would be the
        // fix only if Bun ever shared a receive buffer, and Task 11's byte-length
        // test is what would catch that.
        if (typeof data !== 'string' && !(data instanceof ArrayBuffer)) {
          teardown(INTERNAL_CLOSE_CODE, undefined, 'downstream');
          return;
        }
        try {
          upstream.send(data);
        } catch {
          teardown(INTERNAL_CLOSE_CODE, undefined, 'downstream');
          return;
        }
        // Measured after the send, never before: the client `WebSocket.send()` returns
        // `undefined` on Bun 1.4.2, so the frame just handed over is only observable in
        // `bufferedAmount`. A check ahead of the send reads a queue that does not yet
        // include this frame, so one frame larger than the ceiling passes it and — with
        // no later frame to re-check — leaves the relay open around an unbounded queue.
        // Measured: an 8 MiB frame takes `bufferedAmount` from 0 to ~8 MB in one call.
        if (upstream.bufferedAmount > BACKPRESSURE_LIMIT) {
          teardown(INTERNAL_CLOSE_CODE, undefined, 'downstream');
        }
      },
      onClose(event: CloseEvent) {
        teardown(event.code, event.reason, 'downstream');
      },
    },
  };
}

/** `WSContext.send` discards Bun's backpressure result and exposes no `drain`, so
 *  the real queued byte count comes from the underlying `ServerWebSocket`. The origin
 *  is `proxy`: neither peer misbehaved, the proxy's own ceiling tripped.
 *
 *  Read after the send for the same reason as the upstream leg: before it, the queue
 *  does not yet include the frame being handed over, so a single frame larger than the
 *  ceiling clears the check and nothing re-reads the queue unless another frame
 *  arrives. `raw.send()`'s own return value is not used as the gate because it only
 *  reports *that* backpressure was applied (`-1` measured on Bun 1.4.2), not how many
 *  bytes are queued, and the advertised ceiling is a byte count. */
function sendDownstream(ws: WSContext, data: string | ArrayBuffer, teardown: Teardown): void {
  const raw = ws.raw as { getBufferedAmount?: () => number } | undefined;
  try {
    ws.send(data);
  } catch {
    teardown(INTERNAL_CLOSE_CODE);
    return;
  }
  if ((raw?.getBufferedAmount?.() ?? 0) > BACKPRESSURE_LIMIT) teardown(INTERNAL_CLOSE_CODE);
}

export function closeQuietly(socket: WebSocket, code: number, reason?: string): void {
  try {
    socket.close(code, reason);
  } catch {}
}
