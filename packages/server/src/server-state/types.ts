import type {
  AtomicConfigFile,
  BuiltInPluginDefinition,
  ModelsDevCatalog,
  PluginLogSink,
  PluginPackageImporter,
  PluginRegistrySnapshot,
  PluginRepository,
  Router,
} from "@aio-proxy/core";
import type { RequestLogStore } from "@aio-proxy/core/db";
import type {
  Config,
  DashboardEvent,
  DashboardPluginSummary,
  DashboardProviderSummary,
  ProviderState,
} from "@aio-proxy/types";
import type { ConfigStore } from "../config-store";
import type { DashboardEventHub, DashboardEventLimits } from "../dashboard-events";
import type { CatalogJobDescriptor, PluginRuntimeCacheEntry } from "../plugin-runtime";
import type { ProviderProbe } from "../provider-runtime";
import type {
  ProviderRouteSnapshot,
  ProviderRouteSource,
  RuntimeProviderInput,
  RuntimeProviderInstance,
} from "../runtime";

export type ServerStateOptions = {
  readonly config: Config;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly logger?: (entry: ConfigReloadLog) => void;
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
};

export type InternalServerStateOptions = ServerStateOptions & { readonly __test?: ServerStateTestHooks };

export type ConfigReloadLog = {
  readonly error: string;
  readonly event: "config.reload_failed";
  readonly stage: "parse" | "providers" | "router" | "alias-collision";
};

export type ConfigChangedData = Extract<DashboardEvent, { readonly event: "config.changed" }>["data"];
export type ReloadFailure = { readonly error: string; readonly ok: false; readonly stage: ConfigReloadLog["stage"] };
export type ConfigReloadResult = { readonly ok: true; readonly diff: ConfigChangedData } | ReloadFailure;

export type ServerState = ProviderRouteSource & {
  readonly close: () => void;
  readonly configPath: string | undefined;
  readonly configStore: ConfigStore;
  readonly events: DashboardEventHub;
  readonly modelsDevCatalog: () => Promise<ModelsDevCatalog | undefined>;
  readonly pluginSummaries: () => readonly DashboardPluginSummary[];
  readonly providerSummaries: (options: ProviderSummaryOptions) => Promise<readonly DashboardProviderSummary[]>;
  readonly reload: () => Promise<ConfigReloadResult>;
  readonly currentConfig: () => Config;
  readonly requestLog: RequestLogStore;
};

export type ProviderSummaryOptions = { readonly filter?: string | undefined; readonly probe: boolean };

export type Snapshot = ProviderRouteSnapshot & {
  readonly config: Config;
  readonly plugins: PluginRegistrySnapshot;
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly DashboardProviderSummary[];
  readonly catalogJobs: readonly CatalogJobDescriptor[];
  readonly runtimeCache: ReadonlyMap<string, PluginRuntimeCacheEntry>;
  readonly providerStates: ReadonlyMap<string, ProviderState>;
};

export type ProviderStatus = { readonly last_latency: number | null; readonly last_status: string };
