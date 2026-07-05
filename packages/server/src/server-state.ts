import { readFile } from "node:fs/promises";
import { Router } from "@aio-proxy/core";
import {
  type Config,
  ConfigSchema,
  type DashboardEvent,
  type DashboardProviderProbe,
  type DashboardProviderSummary,
} from "@aio-proxy/types";
import { ZodError } from "zod";
import { watchConfigFile } from "./config-watcher";
import { createDashboardEventHub, type DashboardEventHub, type DashboardEventLimits } from "./dashboard-events";
import { materializeProviders, type ProviderProbe, providerDiff, providerSummary } from "./provider-runtime";
import type { ProviderRouteSnapshot, ProviderRouteSource, RuntimeProviderInstance } from "./runtime";

export type ServerStateOptions = {
  readonly config: Config;
  readonly configPath?: string;
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
  readonly events: DashboardEventHub;
  readonly providerSummaries: (options: ProviderSummaryOptions) => Promise<readonly DashboardProviderSummary[]>;
  readonly reload: () => Promise<ConfigReloadResult>;
  readonly redactedConfig: () => Config;
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

export function createServerState(options: ServerStateOptions): ServerState {
  let snapshot = buildSnapshotFromConfig(options.config);
  if (options.providerInstances !== undefined) {
    snapshot = buildSnapshotWithProviders(snapshot.config, options.providerInstances);
  }

  const statuses = new Map<string, ProviderStatus>();
  const events = createDashboardEventHub(options.eventLimits);
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

  return {
    close() {
      watcher?.close();
      events.close();
    },
    currentProviderSnapshot() {
      return snapshot;
    },
    events,
    providerSummaries,
    redactedConfig() {
      return snapshot.config;
    },
    reload,
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
