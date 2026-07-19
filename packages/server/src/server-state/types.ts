import type {
  AtomicConfigFile,
  BuiltInPluginDefinition,
  ModelsDevCatalog,
  PluginLogSink,
  PluginPackageImporter,
  PluginRepository,
  Router,
} from "@aio-proxy/core";
import type { RequestLogStore } from "@aio-proxy/core/db";
import type {
  Config,
  DashboardEvent,
  DashboardOAuthCapability,
  DashboardOAuthProviderEdit,
  DashboardProviderSummary,
} from "@aio-proxy/types";

import type { ConfigStore } from "../config-store";
import type { DashboardEventHub, DashboardEventLimits } from "../dashboard-events";
import type { OAuthLoginSessionManager } from "../oauth-login-session/manager";
import type { OAuthQuotaOperations } from "../plugin-quota";
import type { CatalogJobDescriptor } from "../plugin-runtime";
import type { ProviderRouteSource, RuntimeProviderInput, RuntimeProviderInstance } from "../runtime";
import type { ConfigReloadLog, ServerLogSink } from "../server-log";

export type ServerStateOptions = {
  readonly config: Config;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly logger?: ServerLogSink;
  readonly modelsDevCatalogTask?: () => Promise<ModelsDevCatalog | undefined>;
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

export type ServerStateTestHooks = {
  readonly configFile?: AtomicConfigFile;
  readonly createRouter?: (providers: readonly RuntimeProviderInstance[]) => Router<RuntimeProviderInstance>;
  readonly onCatalogJobsReplaced?: (jobs: readonly CatalogJobDescriptor[]) => void;
  readonly reconciliationRetryMs?: number;
  readonly recoveryScheduler?: RecoveryScheduler;
  readonly recoverPendingAccountOperations?: typeof import("@aio-proxy/core").recoverPendingAccountOperations;
  readonly oauthSessionNow?: () => number;
  readonly oauthSessionTtlMs?: number;
};

export type InternalServerStateOptions = ServerStateOptions & { readonly __test?: ServerStateTestHooks };

export type ConfigChangedData = Extract<DashboardEvent, { readonly event: "config.changed" }>["data"];
export type ReloadFailure = { readonly error: string; readonly ok: false; readonly stage: ConfigReloadLog["stage"] };
export type ConfigReloadResult = { readonly ok: true; readonly diff: ConfigChangedData } | ReloadFailure;

export type ServerState = ProviderRouteSource & {
  readonly close: () => void;
  readonly configPath: string | undefined;
  readonly configStore: ConfigStore;
  readonly events: DashboardEventHub;
  readonly modelsDevCatalog: () => Promise<ModelsDevCatalog | undefined>;
  readonly oauthQuota: OAuthQuotaOperations;
  readonly oauthCapabilities: () => readonly DashboardOAuthCapability[];
  readonly oauthProviderEditView: (providerId: string) => DashboardOAuthProviderEdit | undefined;
  readonly oauthLoginSessions: OAuthLoginSessionManager;
  readonly providerSummaries: (options: ProviderSummaryOptions) => Promise<readonly DashboardProviderSummary[]>;
  readonly reload: () => Promise<ConfigReloadResult>;
  readonly currentConfig: () => Config;
  readonly requestLog: RequestLogStore;
};

export type ProviderSummaryOptions = { readonly filter?: string | undefined; readonly probe: boolean };

export type { ConfigReloadLog } from "../server-log";
