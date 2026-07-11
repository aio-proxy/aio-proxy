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
import { materializeProviders, type ProviderProbe, providerDiff, providerSummary } from "./provider-runtime";
import { createRequestRecorder } from "./request-recorder";
import type { ProviderRouteSnapshot, ProviderRouteSource, RuntimeProviderInstance } from "./runtime";
import { createUsageCapture, type PassthroughUsageOptions, type StreamUsageOptions } from "./usage-capture";

export type ServerStateOptions = {
  readonly config: Config;
  readonly configPath?: string;
  readonly dbHome?: string;
  readonly eventLimits?: DashboardEventLimits;
  readonly logger?: (entry: ConfigReloadLog) => void;
  readonly providerInstances?: readonly RuntimeProviderInstance[];
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
  readonly redactedConfig: () => Config;
  readonly requestLog: RequestLogStore;
  readonly usageLedger: LegacyUsageLedger;
};

type LegacyUsageRow = {
  readonly id: string;
  readonly traceId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly priceModelId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly createdAt: Date;
};

type LegacyUsageSummary = {
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
};

type LegacyUsageLedger = {
  readonly list: (limit: number) => readonly LegacyUsageRow[];
  readonly summary: (limit: number) => LegacyUsageSummary;
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
  let snapshot = buildSnapshotFromConfig(options.config);
  if (options.providerInstances !== undefined) {
    snapshot = buildSnapshotWithProviders(snapshot.config, options.providerInstances);
  }

  const statuses = new Map<string, ProviderStatus>();
  const events = createDashboardEventHub(options.eventLimits);
  const dbHandle = openServerDb(options);
  const usageLedger = createLegacyUsageLedger(dbHandle);
  const requestLog = createRequestLogStore(dbHandle.db);
  const usageCapture = createUsageCapture({ priceCatalogTask: createPriceCatalogTask() });
  const requestRecorder = createRequestRecorder({ store: requestLog });
  const usageRecorder = {
    recordStreamUsage: ({ traceId: _traceId, ...captureOptions }: StreamUsageOptions & { readonly traceId: string }) =>
      usageCapture.stream(captureOptions).value,
    recordPassthroughUsage: ({
      traceId: _traceId,
      ...captureOptions
    }: PassthroughUsageOptions & { readonly traceId: string }) => usageCapture.passthrough(captureOptions).value,
  };
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
    redactedConfig() {
      return snapshot.config;
    },
    reload,
    requestLog,
    requestRecorder,
    usageCapture,
    usageLedger,
    usageRecorder,
  };
}

function createLegacyUsageLedger(handle: OpenDbHandle): LegacyUsageLedger {
  const list = (limit: number): readonly LegacyUsageRow[] =>
    handle.sqlite
      .query<LegacyDbUsageRow, [number]>(
        `SELECT id, request_id, provider_id, model_id, price_model_id, input_tokens, output_tokens,
          total_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, estimated_cost_usd, created_at
        FROM usage ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit)
      .map(legacyUsageRow);

  return {
    list,
    summary(limit) {
      return list(limit).reduce<LegacyUsageSummary>(
        (total, row) => ({
          requestCount: total.requestCount + 1,
          inputTokens: total.inputTokens + (row.inputTokens ?? 0),
          outputTokens: total.outputTokens + (row.outputTokens ?? 0),
          totalTokens: total.totalTokens + (row.totalTokens ?? 0),
          cacheReadTokens: total.cacheReadTokens + (row.cacheReadTokens ?? 0),
          cacheWriteTokens: total.cacheWriteTokens + (row.cacheWriteTokens ?? 0),
          reasoningTokens: total.reasoningTokens + (row.reasoningTokens ?? 0),
          estimatedCostUsd: total.estimatedCostUsd + (row.estimatedCostUsd ?? 0),
        }),
        {
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          estimatedCostUsd: 0,
        },
      );
    },
  };
}

type LegacyDbUsageRow = {
  readonly id: string;
  readonly request_id: string;
  readonly provider_id: string;
  readonly model_id: string;
  readonly price_model_id: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly total_tokens: number | null;
  readonly cache_read_tokens: number | null;
  readonly cache_write_tokens: number | null;
  readonly reasoning_tokens: number | null;
  readonly estimated_cost_usd: number | null;
  readonly created_at: number;
};

function legacyUsageRow(row: LegacyDbUsageRow): LegacyUsageRow {
  return {
    id: row.id,
    traceId: row.request_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    ...(row.price_model_id === null ? {} : { priceModelId: row.price_model_id }),
    ...(row.input_tokens === null ? {} : { inputTokens: row.input_tokens }),
    ...(row.output_tokens === null ? {} : { outputTokens: row.output_tokens }),
    ...(row.total_tokens === null ? {} : { totalTokens: row.total_tokens }),
    ...(row.cache_read_tokens === null ? {} : { cacheReadTokens: row.cache_read_tokens }),
    ...(row.cache_write_tokens === null ? {} : { cacheWriteTokens: row.cache_write_tokens }),
    ...(row.reasoning_tokens === null ? {} : { reasoningTokens: row.reasoning_tokens }),
    ...(row.estimated_cost_usd === null ? {} : { estimatedCostUsd: row.estimated_cost_usd }),
    createdAt: new Date(row.created_at),
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

function buildSnapshotWithProviders(config: Config, providers: readonly RuntimeProviderInstance[]): Snapshot {
  return buildSnapshot(
    config,
    providers,
    new Map<string, ProviderProbe>(),
    providers.map((provider) => providerSummary(provider)),
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
