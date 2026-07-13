import { readFile } from "node:fs/promises";
import { createOpenRouterPriceCatalog, type OpenRouterPriceCatalog, Router } from "@aio-proxy/core";
import { createRequestLogStore, type OpenDbHandle, openDb, type RequestLogStore } from "@aio-proxy/core/db";
import {
  type Config,
  ConfigSchema,
  type DashboardEvent,
  type DashboardProviderProbe,
  type DashboardProviderSummary,
} from "@aio-proxy/types";
import { ZodError } from "zod";
import { type ConfigStore, createConfigStore } from "./config-store";
import { watchConfigFile } from "./config-watcher";
import { createDashboardEventHub, type DashboardEventHub, type DashboardEventLimits } from "./dashboard-events";
import {
  materializeProviders,
  materializeRuntimeProvider,
  type ProviderProbe,
  providerDiff,
  providerSummary,
} from "./provider-runtime";
import { createRequestRecorder } from "./request-recorder";
import type {
  ProviderRouteSnapshot,
  ProviderRouteSource,
  RuntimeProviderInput,
  RuntimeProviderInstance,
} from "./runtime";
import { createUsageCapture } from "./usage-capture";

export type ServerStateOptions = {
  readonly config: Config;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly logger?: (entry: ConfigReloadLog) => void;
  readonly providerInstances?: readonly RuntimeProviderInput[];
  readonly watchConfig?: boolean;
};

export type ConfigReloadLog = {
  readonly error: string;
  readonly event: "config.reload_failed";
  readonly stage: "parse" | "providers" | "router" | "alias-collision";
};

export type ConfigReloadResult = { readonly ok: true; readonly diff: ConfigChangedData } | ReloadFailure;

export type ServerState = ProviderRouteSource & {
  readonly close: () => void;
  readonly configPath: string | undefined;
  readonly configStore: ConfigStore;
  readonly events: DashboardEventHub;
  readonly providerSummaries: (options: ProviderSummaryOptions) => Promise<readonly DashboardProviderSummary[]>;
  readonly reload: () => Promise<ConfigReloadResult>;
  readonly currentConfig: () => Config;
  readonly requestLog: RequestLogStore;
};

export type ProviderSummaryOptions = {
  readonly filter?: string | undefined;
  readonly probe: boolean;
};

type ConfigChangedData = Extract<DashboardEvent, { readonly event: "config.changed" }>["data"];

type ReloadFailure = {
  readonly error: string;
  readonly ok: false;
  readonly stage: ConfigReloadLog["stage"];
};

type Snapshot = ProviderRouteSnapshot & {
  readonly config: Config;
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly DashboardProviderSummary[];
};

type ProviderStatus = {
  readonly last_latency: number | null;
  readonly last_status: string;
};

const defaultLogger = (entry: ConfigReloadLog): void => {
  console.error(JSON.stringify(entry));
};
const PRICE_CATALOG_TTL_MS = 6 * 60 * 60 * 1_000;

export function createServerState(options: ServerStateOptions): ServerState {
  let snapshot =
    options.providerInstances === undefined
      ? buildSnapshotFromConfig(options.config)
      : buildSnapshotWithProviders(options.config, options.providerInstances);

  const statuses = new Map<string, ProviderStatus>();
  const events = createDashboardEventHub(options.eventLimits);
  const dbHandle = openServerDb(options);
  const requestLog = createRequestLogStore(dbHandle.db);
  const usageCapture = createUsageCapture({ priceCatalogTask: createPriceCatalogTask() });
  const requestRecorder = createRequestRecorder({ store: requestLog });
  const logger = options.logger ?? defaultLogger;
  const watcher =
    options.configPath !== undefined && options.watchConfig !== false
      ? watchConfigFile(options.configPath, reload)
      : undefined;

  async function reload(): Promise<ConfigReloadResult> {
    const result = await buildReloadSnapshot(options.configPath, snapshot.config);
    if (!result.ok) {
      logger({
        error: result.error,
        event: "config.reload_failed",
        stage: result.stage,
      });
      return result;
    }

    const diff = providerDiff(snapshot.summaries, result.snapshot.summaries);
    snapshot = result.snapshot;
    events.publish({ event: "config.changed", data: diff });
    return { ok: true, diff };
  }

  async function providerSummaries({
    filter,
    probe,
  }: ProviderSummaryOptions): Promise<readonly DashboardProviderSummary[]> {
    const rows = snapshot.summaries.filter((provider) => filter === undefined || provider.id === filter);
    if (!probe) {
      return rows.map((provider) => mergeStatus(provider, statuses.get(provider.id)));
    }

    return Promise.all(
      rows.map(async (provider) => {
        const started = performance.now();
        const probeStatus = await runProbe(provider.id, snapshot.probes);
        const status = {
          last_latency: Math.round(performance.now() - started),
          last_status: probeStatus,
        };
        statuses.set(provider.id, status);
        return { ...provider, ...status, probe: probeStatus };
      }),
    );
  }

  const configStore = createConfigStore({
    getConfigPath: () => options.configPath,
    reload,
  });

  return {
    close() {
      watcher?.close();
      events.close();
      dbHandle.close();
    },
    configPath: options.configPath,
    configStore,
    currentProviderSnapshot() {
      return snapshot;
    },
    events,
    providerSummaries,
    currentConfig() {
      return snapshot.config;
    },
    reload,
    requestLog,
    requestRecorder,
    usageCapture,
  };
}

function openServerDb(options: ServerStateOptions): OpenDbHandle {
  return options.dbHome === undefined ? openDb() : openDb({ home: options.dbHome });
}

function createPriceCatalogTask(): () => Promise<OpenRouterPriceCatalog | undefined> {
  let priceCatalog:
    | {
        readonly expiresAt: number;
        readonly task: Promise<OpenRouterPriceCatalog | undefined>;
      }
    | undefined;

  return () => {
    const now = Date.now();
    if (priceCatalog === undefined || priceCatalog.expiresAt <= now) {
      priceCatalog = {
        expiresAt: now + PRICE_CATALOG_TTL_MS,
        task: createOpenRouterPriceCatalog().catch((error: unknown) => {
          if (error instanceof Error) {
            return undefined;
          }
          throw error;
        }),
      };
    }
    return priceCatalog.task;
  };
}

async function buildReloadSnapshot(
  configPath: string | undefined,
  fallback: Config,
): Promise<{ readonly ok: true; readonly snapshot: Snapshot } | ReloadFailure> {
  try {
    const config =
      configPath === undefined ? fallback : ConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
    // Provider and router construction is CPU-only and completes before the atomic swap.
    return { ok: true, snapshot: buildSnapshotFromConfig(config) };
  } catch (error) {
    return reloadError(error);
  }
}

function buildSnapshotFromConfig(config: Config): Snapshot {
  const runtime = materializeProviders(config);
  return buildSnapshot(config, runtime.providers, runtime.probes, runtime.summaries);
}

function buildSnapshotWithProviders(config: Config, providers: readonly RuntimeProviderInput[]): Snapshot {
  const materialized = providers.map((provider) => materializeRuntimeProvider(provider));
  return buildSnapshot(
    config,
    materialized,
    new Map<string, ProviderProbe>(),
    materialized.map((provider) => providerSummary(provider)),
  );
}

function buildSnapshot(
  config: Config,
  providers: readonly RuntimeProviderInstance[],
  probes: ReadonlyMap<string, ProviderProbe>,
  summaries: readonly DashboardProviderSummary[],
): Snapshot {
  const router = new Router(providers);
  return { config, probes, providers, router, summaries };
}

function reloadError(error: unknown): ReloadFailure {
  if (error instanceof SyntaxError || error instanceof ZodError) {
    return { ok: false, error: error.message, stage: "parse" };
  }
  if (error instanceof Error) {
    const stage = error.name === "RouterModelCollisionError" ? "alias-collision" : "providers";
    return { ok: false, error: error.message, stage };
  }
  return { ok: false, error: String(error), stage: "providers" };
}

function mergeStatus(provider: DashboardProviderSummary, status: ProviderStatus | undefined): DashboardProviderSummary {
  if (status === undefined) {
    return provider;
  }
  return { ...provider, ...status };
}

async function runProbe(
  providerId: string,
  probes: ReadonlyMap<string, ProviderProbe>,
): Promise<DashboardProviderProbe> {
  const probe = probes.get(providerId);
  if (probe === undefined) {
    return "OK";
  }
  return probe();
}
