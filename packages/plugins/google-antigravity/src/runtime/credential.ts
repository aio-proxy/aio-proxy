import type { CredentialPort } from "@aio-proxy/plugin-sdk";

import type { GoogleAntigravityCredential } from "../schema";

import { currentGoogleCredential, forceRefreshGoogleCredential } from "../oauth/refresh";

export type AntigravityCredentialSource = {
  readonly current: (signal?: AbortSignal) => Promise<GoogleAntigravityCredential>;
  readonly forceRefresh: (signal?: AbortSignal) => Promise<GoogleAntigravityCredential>;
};

export type AntigravityCredentialDependencies = {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
};

export function createAntigravityCredentialSource(
  credentials: CredentialPort<GoogleAntigravityCredential>,
  dependencies: AntigravityCredentialDependencies = {},
): AntigravityCredentialSource {
  return {
    current: async (signal) =>
      (
        await currentGoogleCredential(credentials, {
          ...dependencies,
          ...(signal === undefined ? {} : { signal }),
        })
      ).value,
    forceRefresh: async (signal) =>
      (
        await forceRefreshGoogleCredential(credentials, {
          ...dependencies,
          ...(signal === undefined ? {} : { signal }),
        })
      ).value,
  };
}
