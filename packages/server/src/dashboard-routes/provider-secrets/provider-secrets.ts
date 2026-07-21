import { resolveConfigTemplates } from "@aio-proxy/core";

const OPENAI_SECRET_PATTERN = /^sk-[A-Za-z0-9_-]{20,}$/;
const BEARER_SECRET_PATTERN = /^Bearer\s+.+$/i;
const TOKEN_SECRET_PATTERN = /^Token\s+.+$/i;
const API_KEY_TEXT_PATTERN = /("?apiKey"?\s*:\s*")[^"]*(")/gi;
const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|authorization|bearer|credential|password|secret|token)/i;
const MUSTACHE_PATTERN = /\{\{[\s\S]*\}\}/u;

const isSecretBoundaryKey = (key: string): boolean =>
  SENSITIVE_KEY_PATTERN.test(key) || key.toLowerCase() === "headers" || key.toLowerCase() === "proxy";

const maskSecret = (key: string, value: string): string => {
  if (OPENAI_SECRET_PATTERN.test(value)) {
    return "sk-****";
  }

  if (BEARER_SECRET_PATTERN.test(value) || TOKEN_SECRET_PATTERN.test(value)) {
    return "****";
  }

  if (isSecretBoundaryKey(key)) {
    return "****";
  }

  return value.replace(API_KEY_TEXT_PATTERN, "$1****$2");
};

export const redactSecrets = (value: unknown, key = "", insideSecretBoundary = false): unknown => {
  if (typeof value === "string") {
    return insideSecretBoundary ? "****" : maskSecret(key, value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, key, insideSecretBoundary));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSecrets(
          entryValue,
          entryKey,
          insideSecretBoundary || entryKey.toLowerCase() === "headers" || entryKey.toLowerCase() === "proxy",
        ),
      ]),
    );
  }

  return value;
};

export function retainRedactedSecrets(
  previous: Record<string, unknown>,
  submitted: Record<string, unknown>,
): Record<string, unknown> {
  return mergeRecord(previous, submitted, false);
}

export function retainAuthoredTemplateStrings(
  authored: unknown,
  submitted: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): unknown {
  if (typeof submitted === "string") {
    if (typeof authored === "string" && MUSTACHE_PATTERN.test(authored)) {
      const expanded = resolveConfigTemplates(authored, env);
      if (submitted === expanded) return authored;
    }
    return submitted;
  }

  if (Array.isArray(submitted)) {
    const previousItems = Array.isArray(authored) ? authored : [];
    return submitted.map((value, index) => retainAuthoredTemplateStrings(previousItems[index], value, env));
  }

  if (isRecord(submitted)) {
    const previous = isRecord(authored) ? authored : {};
    return Object.fromEntries(
      Object.entries(submitted).map(([key, value]) => [key, retainAuthoredTemplateStrings(previous[key], value, env)]),
    );
  }

  return submitted;
}

function mergeRecord(
  previous: Record<string, unknown>,
  submitted: Record<string, unknown>,
  insideSecretBoundary: boolean,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(submitted).map(([key, value]) => [
      key,
      mergeValue(
        previous[key],
        value,
        key,
        insideSecretBoundary || key.toLowerCase() === "headers" || key.toLowerCase() === "proxy",
      ),
    ]),
  );
}

function mergeValue(previous: unknown, submitted: unknown, key: string, insideSecretBoundary: boolean): unknown {
  if (typeof previous === "string" && typeof submitted === "string") {
    const redacted = insideSecretBoundary ? "****" : maskSecret(key, previous);
    return redacted !== previous && submitted === redacted ? previous : submitted;
  }

  if (Array.isArray(submitted)) {
    const previousItems = Array.isArray(previous) ? previous : [];
    return submitted.map((value, index) => mergeValue(previousItems[index], value, key, insideSecretBoundary));
  }

  if (isRecord(submitted)) {
    return mergeRecord(isRecord(previous) ? previous : {}, submitted, insideSecretBoundary);
  }

  return submitted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
