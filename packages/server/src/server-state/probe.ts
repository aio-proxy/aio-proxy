import type { DashboardProviderProbe, DashboardProviderSummary } from "@aio-proxy/types";
import type { ProviderProbe } from "../provider-runtime";
import type { ProviderStatus } from "./types";

export function mergeStatus(
  provider: DashboardProviderSummary,
  status: ProviderStatus | undefined,
): DashboardProviderSummary {
  return status === undefined ? provider : { ...provider, ...status };
}

export async function runProbe(
  providerId: string,
  probes: ReadonlyMap<string, ProviderProbe>,
): Promise<DashboardProviderProbe> {
  return (await probes.get(providerId)?.()) ?? "OK";
}
