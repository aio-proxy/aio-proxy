import type { OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import type { OAuthQuotaServiceDependencies } from "./context";
import { createOAuthQuotaReader } from "./read";
import { createOAuthQuotaResetter } from "./reset";

export type OAuthQuotaOperations = {
  readonly read: (providerId: string, signal: AbortSignal) => Promise<OAuthQuotaSnapshot>;
  readonly reset: (providerId: string, signal: AbortSignal) => Promise<void>;
};

export function createOAuthQuotaOperations(dependencies: OAuthQuotaServiceDependencies): OAuthQuotaOperations {
  return {
    ...createOAuthQuotaReader(dependencies),
    ...createOAuthQuotaResetter(dependencies),
  };
}

export * from "./errors";
