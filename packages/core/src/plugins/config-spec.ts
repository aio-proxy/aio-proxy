import {
  type ConfigSpec,
  type FormCondition,
  type FormField,
  type JsonValue,
  type LocalizedText,
  LocalizedTextSchema,
} from "@aio-proxy/plugin-sdk";
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

function localizedText(value: unknown): LocalizedText | undefined {
  const parsed = LocalizedTextSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function optionalLocalizedText(value: unknown): LocalizedText | null | undefined {
  return value === undefined ? undefined : (localizedText(value) ?? null);
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

function validateSelectOptions(value: unknown):
  | readonly {
      readonly value: string | number | boolean;
      readonly label: LocalizedText;
      readonly description?: LocalizedText;
    }[]
  | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const seen = new Set<string>();
  const validated: {
    value: string | number | boolean;
    label: LocalizedText;
    description?: LocalizedText;
  }[] = [];
  for (const option of value) {
    if (!isRecord(option)) return undefined;
    const { value: optionValue, label, description } = option;
    if (!["string", "number", "boolean"].includes(typeof optionValue)) return undefined;
    if (typeof optionValue === "number" && !Number.isFinite(optionValue)) return undefined;
    const validatedLabel = localizedText(label);
    const validatedDescription = optionalLocalizedText(description);
    if (validatedLabel === undefined || validatedDescription === null) return undefined;
    const key = primitiveKey(optionValue as string | number | boolean);
    if (seen.has(key)) return undefined;
    seen.add(key);
    validated.push({
      value: optionValue as string | number | boolean,
      label: validatedLabel,
      ...(validatedDescription === undefined ? {} : { description: validatedDescription }),
    });
  }
  return validated;
}

function validateField(value: unknown, knownKeys: ReadonlySet<string>): FormField | undefined {
  if (!isRecord(value)) return undefined;
  const { key, label, description, when, type, placeholder, defaultValue, options } = value;
  if (typeof key !== "string" || key.trim() === "" || key !== key.trim()) return undefined;
  const validatedLabel = localizedText(label);
  const validatedDescription = optionalLocalizedText(description);
  if (knownKeys.has(key) || validatedLabel === undefined || validatedDescription === null) return undefined;
  if (!validateWhen(when, knownKeys)) return undefined;
  const base = {
    key,
    label: validatedLabel,
    ...(validatedDescription === undefined ? {} : { description: validatedDescription }),
    ...(when === undefined ? {} : { when: { key: when.key, equals: when.equals } }),
  };
  const validatedPlaceholder = optionalLocalizedText(placeholder);

  switch (type) {
    case "text":
    case "number":
      return validatedPlaceholder === null
        ? undefined
        : { ...base, type, ...(validatedPlaceholder === undefined ? {} : { placeholder: validatedPlaceholder }) };
    case "secret":
      return placeholder === undefined ? { ...base, type } : undefined;
    case "boolean":
      return defaultValue === undefined || typeof defaultValue === "boolean"
        ? { ...base, type, ...(defaultValue === undefined ? {} : { defaultValue }) }
        : undefined;
    case "select": {
      const validatedOptions = validateSelectOptions(options);
      return validatedOptions === undefined ? undefined : { ...base, type, options: validatedOptions };
    }
    case "json":
      return validatedPlaceholder !== null && (defaultValue === undefined || isJsonValue(defaultValue))
        ? {
            ...base,
            type,
            ...(validatedPlaceholder === undefined ? {} : { placeholder: validatedPlaceholder }),
            ...(defaultValue === undefined ? {} : { defaultValue }),
          }
        : undefined;
    default:
      return undefined;
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
  const validatedForm: FormField[] = [];
  for (const field of form) {
    const validated = validateField(field, keys);
    if (validated === undefined) throw new ConfigSpecValidationError();
    validatedForm.push(validated);
    keys.add(validated.key);
    if (validated.type === "secret") secretKeys.add(validated.key);
  }

  return { spec: { schema: schema as ConfigSpec<T>["schema"], form: validatedForm }, secretKeys };
}
