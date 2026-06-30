import type { ProviderProtocol } from "@aio-proxy/types";

export type ProviderSummary = {
  readonly id: string;
  readonly protocol: ProviderProtocol;
};
