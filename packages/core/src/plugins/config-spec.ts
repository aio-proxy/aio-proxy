import type { ConfigSpec, FormCondition, FormField, JsonValue } from "@aio-proxy/plugin-sdk";
import { isPluginZodSchema } from "./schema";

export type ValidatedConfigSpec<T = unknown> = {
  readonly spec: ConfigSpec<T>;
  readonly secretKeys: ReadonlySet<string>;
};

export class ConfigSpecValidationError extends Error {
  constructor() {
    super("Plugin config specification is invalid");
    this.name = "ConfigSpecValidationError";
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const prototype = Object.getPrototypeOf(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : (prototype === Object.prototype || prototype === null) &&
      Object.values(value as Record<string, unknown>).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function validOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function validateWhen(value: unknown, knownKeys: ReadonlySet<string>): value is FormCondition | undefined {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  const { key, equals } = value;
  if (typeof key !== "string" || !knownKeys.has(key)) return false;
  if (typeof equals === "number") return Number.isFinite(equals);
  return equals === null || ["string", "number", "boolean"].includes(typeof equals);
}

function primitiveKey(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`;
}

function validateSelectOptions(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const option of value) {
    if (!isRecord(option)) return false;
    const { value: optionValue, label, description } = option;
    if (!["string", "number", "boolean"].includes(typeof optionValue)) return false;
    if (typeof optionValue === "number" && !Number.isFinite(optionValue)) return false;
    if (typeof label !== "string" || label.trim() === "" || !validOptionalString(description)) return false;
    const key = primitiveKey(optionValue as string | number | boolean);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function validateField(value: unknown, knownKeys: ReadonlySet<string>): value is FormField {
  if (!isRecord(value)) return false;
  const { key, label, description, when, type, placeholder, defaultValue, options } = value;
  if (typeof key !== "string" || key.trim() === "" || key !== key.trim()) return false;
  if (knownKeys.has(key) || typeof label !== "string" || label.trim() === "" || label !== label.trim()) return false;
  if (!validOptionalString(description) || !validateWhen(when, knownKeys)) return false;

  switch (type) {
    case "text":
    case "secret":
    case "number":
      return validOptionalString(placeholder);
    case "boolean":
      return defaultValue === undefined || typeof defaultValue === "boolean";
    case "select":
      return validateSelectOptions(options);
    case "json":
      return validOptionalString(placeholder) && (defaultValue === undefined || isJsonValue(defaultValue));
    default:
      return false;
  }
}

export function validateConfigSpec<T = unknown>(value: unknown): ValidatedConfigSpec<T> {
  if (!isRecord(value)) {
    throw new ConfigSpecValidationError();
  }
  const { schema, form } = value;
  if (!isPluginZodSchema(schema) || !Array.isArray(form)) throw new ConfigSpecValidationError();

  const keys = new Set<string>();
  const secretKeys = new Set<string>();
  for (const field of form) {
    if (!validateField(field, keys)) throw new ConfigSpecValidationError();
    keys.add(field.key);
    if (field.type === "secret") secretKeys.add(field.key);
  }

  return { spec: value as ConfigSpec<T>, secretKeys };
}
