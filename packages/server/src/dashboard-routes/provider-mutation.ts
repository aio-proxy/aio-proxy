import { retainRedactedSecrets } from "./provider-secrets";

export class ProviderAlreadyExistsError extends Error {
  override readonly name = "ProviderAlreadyExistsError";

  constructor(readonly providerId: string) {
    super(`provider ${providerId} already exists`);
  }
}

export class ProviderNotFoundError extends Error {
  override readonly name = "ProviderNotFoundError";

  constructor(readonly providerId: string) {
    super(`provider ${providerId} not found`);
  }
}

export function insertProvider(
  record: Record<string, unknown>,
  providerId: string,
  provider: Record<string, unknown>,
): Record<string, unknown> {
  if (Object.hasOwn(record, providerId)) {
    throw new ProviderAlreadyExistsError(providerId);
  }
  return { ...record, [providerId]: provider };
}

export function replaceProvider(
  record: Record<string, unknown>,
  providerId: string,
  provider: Record<string, unknown>,
): Record<string, unknown> {
  if (!Object.hasOwn(record, providerId)) {
    throw new ProviderNotFoundError(providerId);
  }

  const previousValue = record[providerId];
  const previous = isRecord(previousValue) ? previousValue : {};
  const next = retainRedactedSecrets(previous, provider);

  if (provider["alias"] === undefined && previous["alias"] !== undefined) {
    next["alias"] = previous["alias"];
  }

  const apiKeyProvided = typeof provider["apiKey"] === "string" && provider["apiKey"] !== "";
  if (!apiKeyProvided) {
    if (typeof previous["apiKey"] === "string") {
      next["apiKey"] = previous["apiKey"];
    } else {
      delete next["apiKey"];
    }
  }

  return { ...record, [providerId]: next };
}

export function replaceOAuthProvider(
  record: Record<string, unknown>,
  providerId: string,
  provider: Record<string, unknown>,
): Record<string, unknown> {
  const previousValue = record[providerId];
  if (previousValue === undefined) throw new ProviderNotFoundError(providerId);
  if (!isRecord(previousValue) || previousValue["kind"] !== "oauth") {
    throw new Error("PROVIDER_KIND_MISMATCH");
  }
  return replaceProvider(record, providerId, {
    ...provider,
    plugin: previousValue["plugin"],
    capability: previousValue["capability"],
    ...(previousValue["options"] === undefined ? {} : { options: previousValue["options"] }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
