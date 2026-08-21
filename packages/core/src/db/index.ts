export type { OpenDbHandle, OpenDbOptions } from './open-db';
export { openDb, resolveDbPath } from './open-db';
export {
  acquireDatabaseOwnershipLock,
  assertSafeOwnedDatabaseFile,
  DatabaseOwnershipError,
  DatabaseOwnershipPathError,
} from './ownership-lock';
export type { DatabaseOwnershipLock } from './ownership-lock';
export { createTraceStore, decodeTraceCursor, encodeTraceCursor } from './trace-store';
export type {
  DashboardOverviewQuery,
  SessionAffinityObservation,
  SessionIdentity,
  SessionResponseOwner,
  SessionResponseResolution,
  StoredSpan,
  TraceCursor,
  TraceCompletion,
  TraceRootStart,
  TraceStore,
  TraceTerminalSummary,
  TracesPage,
  TracesQuery,
  UsageOverviewQuery,
} from './trace-store';
export {
  agentAccessToken,
  agentInstallation,
  agentRefreshToken,
  agentTokenFamily,
  oauthAccount,
  oauthAccountDiagnostic,
  oauthCatalog,
  oauthPendingOperation,
  oauthRefreshLease,
  pluginSecret,
} from './schema';
