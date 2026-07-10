const OPENAI_SECRET_PATTERN = /^sk-[A-Za-z0-9_-]{20,}$/;
const BEARER_SECRET_PATTERN = /^Bearer\s+.+$/i;
const TOKEN_SECRET_PATTERN = /^Token\s+.+$/i;
const API_KEY_TEXT_PATTERN = /("?apiKey"?\s*:\s*")[^"]*(")/gi;
const SENSITIVE_KEY_PATTERN = /(?:api[-_]?key|authorization|bearer|credential|password|secret|token)/i;

const maskSecret = (key: string, value: string): string => {
  if (OPENAI_SECRET_PATTERN.test(value)) {
    return "sk-****";
  }

  if (BEARER_SECRET_PATTERN.test(value) || TOKEN_SECRET_PATTERN.test(value)) {
    return "****";
  }

  if (SENSITIVE_KEY_PATTERN.test(key) || key.toLowerCase() === "headers") {
    return "****";
  }

  return value.replace(API_KEY_TEXT_PATTERN, "$1****$2");
};

export const redactSecrets = (value: unknown, key = "", insideHeaders = false): unknown => {
  if (typeof value === "string") {
    return insideHeaders ? "****" : maskSecret(key, value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, key, insideHeaders));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactSecrets(entryValue, entryKey, insideHeaders || entryKey.toLowerCase() === "headers"),
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

function mergeRecord(
  previous: Record<string, unknown>,
  submitted: Record<string, unknown>,
  insideHeaders: boolean,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(submitted).map(([key, value]) => [
      key,
      mergeValue(previous[key], value, key, insideHeaders || key.toLowerCase() === "headers"),
    ]),
  );
}

function mergeValue(previous: unknown, submitted: unknown, key: string, insideHeaders: boolean): unknown {
  if (typeof previous === "string" && typeof submitted === "string") {
    const redacted = insideHeaders ? "****" : maskSecret(key, previous);
    return redacted !== previous && submitted === redacted ? previous : submitted;
  }

  if (Array.isArray(submitted)) {
    const previousItems = Array.isArray(previous) ? previous : [];
    return submitted.map((value, index) => mergeValue(previousItems[index], value, key, insideHeaders));
  }

  if (isRecord(submitted)) {
    return mergeRecord(isRecord(previous) ? previous : {}, submitted, insideHeaders);
  }

  return submitted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
