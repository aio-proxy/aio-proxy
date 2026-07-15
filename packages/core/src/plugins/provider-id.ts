import { createHash } from "node:crypto";

export type ProviderIdResolution =
  | { readonly status: "existing"; readonly providerId: string }
  | { readonly status: "new"; readonly providerId: string };

export type ProviderIdentity = {
  readonly providerId: string;
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
};

export type ResolveProviderIdOptions = {
  readonly plugin: string;
  readonly capability: string;
  readonly fingerprint: string;
  readonly suggestedKey: string;
  readonly providerIds: Iterable<string>;
  readonly accounts: Iterable<ProviderIdentity>;
};

export class ProviderIdCollisionError extends Error {
  override readonly name = "ProviderIdCollisionError";

  constructor(readonly providerId: string) {
    super("Unable to allocate a unique Provider ID");
  }
}

export function normalizeSuggestedKey(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return normalized.length === 0 ? "oauth" : normalized;
}

export function resolveProviderId(options: ResolveProviderIdOptions): ProviderIdResolution {
  const accounts = [...options.accounts];
  const existing = accounts
    .filter(
      (account) =>
        account.plugin === options.plugin &&
        account.capability === options.capability &&
        account.fingerprint === options.fingerprint,
    )
    .map((account) => account.providerId)
    .sort()[0];
  if (existing !== undefined) return { status: "existing", providerId: existing };

  const occupied = new Set(options.providerIds);
  for (const account of accounts) occupied.add(account.providerId);
  const base = normalizeSuggestedKey(options.suggestedKey);
  if (!occupied.has(base)) return { status: "new", providerId: base };

  const digest = createHash("sha256")
    .update(`${options.plugin}\0${options.capability}\0${options.fingerprint}`)
    .digest("hex");
  for (let length = 8; length <= digest.length; length += 4) {
    const providerId = `${base}-${digest.slice(0, length)}`;
    if (!occupied.has(providerId)) return { status: "new", providerId };
  }
  throw new ProviderIdCollisionError(`${base}-${digest}`);
}
