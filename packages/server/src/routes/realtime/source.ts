import type { ProviderRouteSource } from '../../runtime';
import type { ServerLogSink } from '../../server-log';
import type { RealtimeCallStore } from './call-store';

/** Deliberately narrower than `ProviderRouteSource`: realtime has no usage capture,
 *  no request recorder, and no cooldown store, so it must not be handed them. */
export type RealtimeRouteSource = {
  readonly acquireProviderSnapshot: ProviderRouteSource['acquireProviderSnapshot'];
  readonly logger: ServerLogSink;
  readonly realtimeCalls: RealtimeCallStore;
};
