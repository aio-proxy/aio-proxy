import type { DashboardProviderProbe, DashboardProviderSummary } from "@aio-proxy/types";

import type { SnapshotManager } from "../plugin-snapshot";
import type { ProviderProbe } from "../provider-runtime";
import type { Snapshot } from "./snapshot";
import type { ProviderSummaryOptions } from "./types";

type ProviderStatus = { readonly last_latency: number | null; readonly last_status: string };

export function createProviderSummaries(
  manager: SnapshotManager,
): (options: ProviderSummaryOptions) => Promise<readonly DashboardProviderSummary[]> {
  const statuses = new Map<string, ProviderStatus>();
  return async ({ filter, probe }) => {
    const lease = manager.acquire();
    try {
      const active = lease.snapshot as Snapshot;
      const rows = active.summaries.filter((provider) => filter === undefined || provider.id === filter);
      if (!probe) return rows.map((provider) => mergeStatus(provider, statuses.get(provider.id)));
      return await Promise.all(
        rows.map(async (provider) => {
          const started = performance.now();
          const probeStatus = await runProbe(provider.id, active.probes);
          const status = { last_latency: Math.round(performance.now() - started), last_status: probeStatus };
          statuses.set(provider.id, status);
          return { ...provider, ...status, probe: probeStatus };
        }),
      );
    } finally {
      lease.release();
    }
  };
}

function mergeStatus(provider: DashboardProviderSummary, status: ProviderStatus | undefined): DashboardProviderSummary {
  return status === undefined ? provider : { ...provider, ...status };
}

async function runProbe(
  providerId: string,
  probes: ReadonlyMap<string, ProviderProbe>,
): Promise<DashboardProviderProbe> {
  return (await probes.get(providerId)?.()) ?? "OK";
}
