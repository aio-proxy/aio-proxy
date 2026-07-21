import { resolveConfigTemplates } from "@aio-proxy/core";
import {
  type ProviderMutationAuthoringBody,
  type ProviderMutationBody,
  ProviderMutationAuthoringBodySchema,
  ProviderMutationBodySchema,
} from "@aio-proxy/types";
import { isPlainObject } from "es-toolkit/predicate";

import { retainAuthoredTemplateStrings, retainRedactedSecrets } from "./provider-secrets";

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

export type ParsedProviderMutation = {
  readonly authored: ProviderMutationAuthoringBody;
  readonly materialized: ProviderMutationBody;
};

export type ProviderMutationParseResult =
  | { readonly ok: true; readonly body: ParsedProviderMutation }
  | { readonly ok: false; readonly status: 400 | 422; readonly payload: Record<string, unknown> };

export function parseProviderMutation(raw: unknown): ProviderMutationParseResult {
  const prepared = stripRedactedProxyPlaceholder(raw);
  const authoredParsed = ProviderMutationAuthoringBodySchema.safeParse(prepared);
  if (!authoredParsed.success) {
    return { ok: false, status: 400, payload: { error: "validation failed", details: authoredParsed.error.issues } };
  }

  let expanded: unknown;
  try {
    expanded = resolveConfigTemplates(authoredParsed.data);
  } catch (error) {
    return {
      ok: false,
      status: 422,
      payload: { error: "config rejected", detail: error instanceof Error ? error.message : String(error) },
    };
  }

  const materializedParsed = ProviderMutationBodySchema.safeParse(expanded);
  if (!materializedParsed.success) {
    return {
      ok: false,
      status: 422,
      payload: { error: "validation failed", details: materializedParsed.error.issues },
    };
  }

  return { ok: true, body: { authored: authoredParsed.data, materialized: materializedParsed.data } };
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
  const previous = isPlainObject(previousValue) ? previousValue : {};
  const next = retainRedactedSecrets(previous, provider);

  for (const key of ["headers", "proxy"] as const) {
    if (provider[key] === undefined && previous[key] !== undefined) next[key] = previous[key];
  }

  const restored = retainAuthoredTemplateStrings(previous, next) as Record<string, unknown>;

  if (provider["alias"] === undefined && previous["alias"] !== undefined) {
    restored["alias"] = previous["alias"];
  }

  const apiKeyProvided = typeof provider["apiKey"] === "string" && provider["apiKey"] !== "";
  if (!apiKeyProvided) {
    if (typeof previous["apiKey"] === "string") {
      restored["apiKey"] = previous["apiKey"];
    } else {
      delete restored["apiKey"];
    }
  }

  return { ...record, [providerId]: restored };
}

export function replaceOAuthProvider(
  record: Record<string, unknown>,
  providerId: string,
  provider: Record<string, unknown>,
): Record<string, unknown> {
  const previousValue = record[providerId];
  if (previousValue === undefined) throw new ProviderNotFoundError(providerId);
  if (!isPlainObject(previousValue) || previousValue["kind"] !== "oauth") {
    throw new Error("PROVIDER_KIND_MISMATCH");
  }
  return replaceProvider(record, providerId, {
    ...provider,
    plugin: previousValue["plugin"],
    capability: previousValue["capability"],
    ...(previousValue["options"] === undefined ? {} : { options: previousValue["options"] }),
  });
}

function stripRedactedProxyPlaceholder(raw: unknown): unknown {
  if (!isPlainObject(raw) || raw["proxy"] !== "****") return raw;
  const { proxy: _proxy, ...rest } = raw;
  return rest;
}
