import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { listRequestLogs } from './request-logs';
import { findAffinity, resolveResponse } from './session-state';
import { complete, prune, recover, startRoot } from './trace-lifecycle';
import { find, list } from './trace-queries';
import type { TraceStore } from './types';
import { overview } from './usage-overview';

export function createTraceStore(db: BunSQLiteDatabase): TraceStore {
  return {
    startRoot: (input) => startRoot(db, input),
    complete: (input) => complete(db, input),
    list: (query) => list(db, query),
    listRequestLogs: (query) => listRequestLogs(db, query),
    find: (traceId) => find(db, traceId),
    overview: (query) => overview(db, query),
    resolveResponse: (responseId, now) => resolveResponse(db, responseId, now),
    findAffinity: (identity, requestedModelId, now) => findAffinity(db, identity, requestedModelId, now),
    recover: (now) => recover(db, now),
    prune: (traceCutoff, sessionCutoff) => prune(db, traceCutoff, sessionCutoff),
  };
}
