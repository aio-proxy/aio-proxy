export type CatalogDiscoveryErrorKind = "retryable" | "authorization" | "empty" | "request";

const messages: Readonly<Record<CatalogDiscoveryErrorKind, string>> = {
  retryable: "Google Antigravity catalog discovery is temporarily unavailable",
  authorization: "Google Antigravity catalog discovery was not authorized",
  empty: "Google Antigravity catalog discovery returned no usable models",
  request: "Google Antigravity catalog discovery request was rejected",
};

export class CatalogDiscoveryError extends Error {
  override readonly name = "CatalogDiscoveryError";
  readonly snapshotEligible: boolean;
  readonly status?: number;

  constructor(
    readonly kind: CatalogDiscoveryErrorKind,
    options: { readonly status?: number } = {},
  ) {
    super(messages[kind]);
    this.snapshotEligible = kind === "retryable";
    if (options.status !== undefined) this.status = options.status;
  }
}
