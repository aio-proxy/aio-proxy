import type {
  AgentIdentityService,
  AtomicConfigFile,
  BuiltInPluginDefinition,
  PluginLogSink,
  PluginPackageImporter,
  PluginRepository,
  Router,
  recoverPendingAccountOperations,
} from '@aio-proxy/core';
import type { TraceStore } from '@aio-proxy/core/db';
import type {
  Config,
  DashboardEvent,
  DashboardOAuthCapability,
  DashboardOAuthProviderEdit,
  DashboardProviderSummary,
} from '@aio-proxy/types';

import type { CatalogRefreshOutcome } from '../catalog-scheduler';
import type { ConfigStore } from '../config-store';
import type { OAuthCredentialRefreshOperations } from '../credential-refresh';
import type { DashboardEventHub, DashboardEventLimits } from '../dashboard-events';
import type { ModelRoutingControlPlane } from '../model-routing';
import type { OAuthLoginSessionManager } from '../oauth-login-session/manager';
import type { PluginControlPlane, PluginControlPlaneOptions } from '../plugin-control-plane';
import type { OAuthQuotaCache, OAuthQuotaOperations } from '../plugin-quota';
import type { CatalogJobDescriptor } from '../plugin-runtime';
import type { ProviderRouteSource, RuntimeProviderInput, RuntimeProviderInstance } from '../runtime';
import type { ConfigReloadLog, ServerLogSink } from '../server-log';

export type ServerStateOptions = {
  readonly config: Config;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly logger?: ServerLogSink;
  readonly providerInstances?: readonly RuntimeProviderInput[];
  readonly watchConfig?: boolean;
  readonly pluginRepository?: PluginRepository;
  readonly importPlugin?: PluginPackageImporter;
  readonly pluginLogger?: PluginLogSink;
  readonly builtIns?: readonly BuiltInPluginDefinition[];
};

export type RecoveryTimer = { readonly clear: () => void };
export type RecoveryScheduler = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => RecoveryTimer;
};

export type CreateRouter = (
  providers: readonly RuntimeProviderInstance[],
  routerConfig: Config['router'],
) => Router<RuntimeProviderInstance>;

export type ServerStateTestHooks = {
  readonly agentIdentity?: AgentIdentityService;
  readonly failStartupAfter?: 'scheduler' | 'recovery' | 'login_sessions' | 'watcher';
  readonly configFile?: AtomicConfigFile;
  readonly createRouter?: CreateRouter;
  readonly onCatalogJobsReplaced?: (jobs: readonly CatalogJobDescriptor[]) => void;
  readonly reconciliationRetryMs?: number;
  readonly recoveryScheduler?: RecoveryScheduler;
  readonly recoverPendingAccountOperations?: typeof recoverPendingAccountOperations;
  readonly oauthSessionNow?: () => number;
  readonly oauthSessionTtlMs?: number;
  readonly pluginControlPlane?: Pick<
    PluginControlPlaneOptions,
    'findInstalledNpmPackage' | 'removeNpmPackageCache' | 'withInstalledNpmPackage' | 'withNpmPackageLifecycle'
  >;
};

export type InternalServerStateOptions = ServerStateOptions & {
  readonly __dashboardAuthHealthChanged?: (available: boolean) => void;
  readonly __test?: ServerStateTestHooks;
};

export type ConfigChangedData = Extract<DashboardEvent, { readonly event: 'config.changed' }>['data'];
export type ReloadFailure = { readonly error: string; readonly ok: false; readonly stage: ConfigReloadLog['stage'] };
export type ConfigReloadResult = { readonly ok: true; readonly diff: ConfigChangedData } | ReloadFailure;

export type ServerState = ProviderRouteSource & {
  readonly agentIdentity: AgentIdentityService;
  readonly close: () => void;
  readonly configPath: string | undefined;
  readonly configStore: ConfigStore;
  readonly events: DashboardEventHub;
  readonly modelRouting: ModelRoutingControlPlane;
  readonly oauthQuota: OAuthQuotaOperations;
  readonly oauthCredentialRefresh: OAuthCredentialRefreshOperations;
  /** Rediscovers one OAuth Provider's model catalog now, ignoring the catalog policy's TTL. */
  readonly refreshProviderCatalog: (providerId: string) => Promise<CatalogRefreshOutcome>;
  readonly quotaCache: OAuthQuotaCache;
  readonly pluginControlPlane: PluginControlPlane;
  readonly oauthCapabilities: () => readonly DashboardOAuthCapability[];
  readonly oauthProviderEditView: (providerId: string) => DashboardOAuthProviderEdit | undefined;
  readonly oauthLoginSessions: OAuthLoginSessionManager;
  readonly providerSummaries: (options: ProviderSummaryOptions) => Promise<readonly DashboardProviderSummary[]>;
  readonly reload: () => Promise<ConfigReloadResult>;
  readonly currentConfig: () => Config;
  readonly traceStore: TraceStore;
};

export type ProviderSummaryOptions = { readonly filter?: string | undefined; readonly probe: boolean };

export type { ConfigReloadLog } from '../server-log';
