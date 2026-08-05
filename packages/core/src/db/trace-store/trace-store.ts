import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { overviewDashboard, overviewDashboardActivity, overviewDashboardDiagnostics } from './overview';
import { findAffinity, markResponseAmbiguous, resolveResponse } from './session-state';
import { complete, prune, recover, startRoot } from './trace-lifecycle/index';
import { find, list } from './trace-queries';
import type { TraceStore } from './types';
import { overview } from './usage-overview';

export function createTraceStore(db: BunSQLiteDatabase): TraceStore {
  return {
    startRoot: (input) => startRoot(db, input),
    complete: (input) => complete(db, input),
    list: (query) => list(db, query),
    find: (traceId, now) => find(db, traceId, now),
    overview: (query) => overview(db, query),
    overviewDashboard: (query) => overviewDashboard(db, query),
    overviewDashboardDiagnostics: () => overviewDashboardDiagnostics(db),
    overviewDashboardActivity: (options) => overviewDashboardActivity(db, options),
    resolveResponse: (responseId, now) => resolveResponse(db, responseId, now),
    markResponseAmbiguous: (responseId, now) => markResponseAmbiguous(db, responseId, now),
    findAffinity: (identity, requestedModelId, now) => findAffinity(db, identity, requestedModelId, now),
    recover: (now) => recover(db, now),
    prune: (traceCutoff, sessionCutoff) => prune(db, traceCutoff, sessionCutoff),
  };
}
