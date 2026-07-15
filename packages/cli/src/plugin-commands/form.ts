import { parsePluginSchema, validateConfigSpec } from "@aio-proxy/core";
import { m } from "@aio-proxy/i18n";
import type { ConfigSpec, FormField } from "@aio-proxy/plugin-sdk";
import { confirm, input, password, select } from "@inquirer/prompts";

type PromptContext = { readonly signal?: AbortSignal };

export type PluginFormPrompts = {
  readonly input: (config: Parameters<typeof input>[0], context?: PromptContext) => Promise<string>;
  readonly password: (config: Parameters<typeof password>[0], context?: PromptContext) => Promise<string>;
  readonly confirm: (config: Parameters<typeof confirm>[0], context?: PromptContext) => Promise<boolean>;
  readonly select: (config: Parameters<typeof select>[0], context?: PromptContext) => Promise<unknown>;
};

const defaultPrompts: PluginFormPrompts = { input, password, confirm, select };

export type RenderConfigSpecOptions = {
  readonly prompts?: PluginFormPrompts;
  readonly currentPublicValues?: Readonly<Record<string, unknown>>;
  readonly currentSecrets?: Readonly<Record<string, unknown>>;
  readonly clearSecrets?: readonly string[];
  readonly signal?: AbortSignal;
};

export type RenderConfigSpecResult = {
  readonly publicValues: Record<string, unknown>;
  readonly secrets: Record<string, unknown>;
};

export class FormNumberInvalidError extends Error {
  override readonly name = "FormNumberInvalidError";
  constructor(readonly key: string) {
    super(m.cli_plugin_error_number_invalid({ key }));
  }
}

export class FormJsonInvalidError extends Error {
  override readonly name = "FormJsonInvalidError";
  constructor(readonly key: string) {
    super(m.cli_plugin_error_json_invalid({ key }));
  }
}

export type FormSchemaIssue = { readonly key: string; readonly message: string };

export class FormSchemaValidationError extends Error {
  override readonly name = "FormSchemaValidationError";
  constructor(readonly issues: readonly FormSchemaIssue[]) {
    super(m.cli_plugin_error_options_invalid());
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported form field: ${String(value)}`);
}

function promptMessage(field: FormField): string {
  return field.description === undefined ? field.label : `${field.label} (${field.description})`;
}

function visible(field: FormField, values: Readonly<Record<string, unknown>>): boolean {
  return field.when === undefined || values[field.when.key] === field.when.equals;
}

function jsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const safe = Array.isArray(value)
    ? value.every((item) => jsonSafe(item, seen))
    : Object.entries(value).every(([key, item]) => typeof key === "string" && jsonSafe(item, seen));
  seen.delete(value);
  return safe;
}

function stableJsonValue(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (typeof value !== "object" || seen.has(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      seen.add(value);
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          items.push("hole");
          continue;
        }
        const item = stableJsonValue(value[index], seen);
        if (item === undefined) return undefined;
        items.push(`value:${item}`);
      }
      return `[${items.join(",")}]`;
    }
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    const fields: string[] = [];
    for (const key of (keys as string[]).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return undefined;
      const encoded = stableJsonValue(descriptor.value, seen);
      if (encoded === undefined) return undefined;
      fields.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${fields.join(",")}}`;
  } catch {
    return undefined;
  } finally {
    seen.delete(value);
  }
}

function jsonSafeEqual(left: unknown, right: unknown): boolean {
  const encoded = stableJsonValue(left);
  return encoded !== undefined && encoded === stableJsonValue(right);
}

function inertJsonError(): never {
  throw new FormSchemaValidationError([{ key: "<root>", message: "Expected inert JSON data" }]);
}

function arrayIndex(key: string, length: number): number | undefined {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 0xffff_ffff && index < length && String(index) === key
    ? index
    : undefined;
}

function cloneInertJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : inertJsonError();
  if (typeof value !== "object" || seen.has(value)) return inertJsonError();
  seen.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) return inertJsonError();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !("value" in lengthDescriptor) ||
        lengthDescriptor.enumerable ||
        !Number.isInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 0xffff_ffff
      ) {
        return inertJsonError();
      }
      const clone: unknown[] = new Array(lengthDescriptor.value);
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string") return inertJsonError();
        const index = arrayIndex(key, lengthDescriptor.value);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (index === undefined || descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          return inertJsonError();
        }
        clone[index] = cloneInertJson(descriptor.value, seen);
      }
      return clone;
    }
    if (prototype !== Object.prototype && prototype !== null) return inertJsonError();
    const clone = Object.create(prototype) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return inertJsonError();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return inertJsonError();
      Object.defineProperty(clone, key, {
        value: cloneInertJson(descriptor.value, seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } catch (error) {
    if (error instanceof FormSchemaValidationError) throw error;
    return inertJsonError();
  } finally {
    seen.delete(value);
  }
}

function compatibleDefault(field: FormField, current: unknown): unknown {
  switch (field.type) {
    case "text":
      return typeof current === "string" ? current : undefined;
    case "secret":
      return current;
    case "number":
      return typeof current === "number" && Number.isFinite(current) ? current : undefined;
    case "boolean":
      return typeof current === "boolean" ? current : field.defaultValue;
    case "select":
      return field.options.some((option) => option.value === current) ? current : undefined;
    case "json":
      return jsonSafe(current) ? current : field.defaultValue;
    default:
      return assertNever(field);
  }
}

function plainRecordEntries(value: unknown): readonly (readonly [string, unknown])[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FormSchemaValidationError([{ key: "<root>", message: "Expected an object" }]);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new FormSchemaValidationError([{ key: "<root>", message: "Expected a plain object" }]);
    }
    return Reflect.ownKeys(value).map((key) => {
      if (typeof key !== "string") {
        throw new FormSchemaValidationError([{ key: "<root>", message: "Expected string record keys" }]);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new FormSchemaValidationError([{ key, message: "Expected a plain record value" }]);
      }
      return [key, descriptor.value] as const;
    });
  } catch (error) {
    if (error instanceof FormSchemaValidationError) throw error;
    throw new FormSchemaValidationError([{ key: "<root>", message: "Expected a plain object" }]);
  }
}

export async function renderConfigSpec<T>(
  configSpec: ConfigSpec<T>,
  options: RenderConfigSpecOptions = {},
): Promise<RenderConfigSpecResult> {
  const { spec, secretKeys } = validateConfigSpec<T>(configSpec);
  const prompts = options.prompts ?? defaultPrompts;
  const currentPublic = options.currentPublicValues ?? {};
  const currentSecrets = options.currentSecrets ?? {};
  const clearSecrets = new Set((options.clearSecrets ?? []).filter((key) => secretKeys.has(key)));
  const formKeys = new Set(spec.form.map((field) => field.key));
  const collected: Record<string, unknown> = Object.fromEntries(
    Object.entries(currentSecrets).filter(([key]) => secretKeys.has(key)),
  );
  const context = options.signal === undefined ? undefined : { signal: options.signal };

  for (const field of spec.form) {
    if (!visible(field, collected)) continue;
    let value: unknown;
    const message = promptMessage(field);
    const current = field.type === "secret" ? currentSecrets[field.key] : currentPublic[field.key];
    const promptDefault = compatibleDefault(field, current);
    switch (field.type) {
      case "text":
        value = await prompts.input(
          {
            message,
            ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
            ...(promptDefault === undefined ? {} : { default: promptDefault as string }),
          },
          context,
        );
        break;
      case "secret":
        value = await prompts.password({ message, ...(field.placeholder === undefined ? {} : { mask: "*" }) }, context);
        if (clearSecrets.has(field.key)) value = undefined;
        else if (value === "") value = current;
        break;
      case "number": {
        const raw = (
          await prompts.input(
            {
              message,
              ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
              ...(promptDefault === undefined ? {} : { default: String(promptDefault) }),
            },
            context,
          )
        ).trim();
        value = raw === "" ? undefined : Number(raw);
        if (value !== undefined && !Number.isFinite(value)) throw new FormNumberInvalidError(field.key);
        break;
      }
      case "boolean":
        value = await prompts.confirm({ message, default: (promptDefault as boolean | undefined) ?? false }, context);
        break;
      case "select":
        value = await prompts.select(
          {
            message,
            choices: field.options.map((option) => ({
              name: option.label,
              value: option.value,
              ...(option.description === undefined ? {} : { description: option.description }),
            })),
            ...(promptDefault === undefined ? {} : { default: promptDefault }),
          },
          context,
        );
        break;
      case "json": {
        const fallback = promptDefault;
        const raw = (
          await prompts.input(
            {
              message,
              ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
              ...(fallback === undefined ? {} : { default: JSON.stringify(fallback) }),
            },
            context,
          )
        ).trim();
        try {
          value = raw === "" ? undefined : JSON.parse(raw);
        } catch {
          throw new FormJsonInvalidError(field.key);
        }
        break;
      }
      default:
        assertNever(field);
    }
    if (value !== undefined) collected[field.key] = value;
  }

  for (const key of clearSecrets) delete collected[key];
  const secretInputKeys = new Set([...secretKeys].filter((key) => Object.hasOwn(collected, key)));
  const publicInputSnapshot = Object.fromEntries(
    plainRecordEntries(
      cloneInertJson(Object.fromEntries(Object.entries(collected).filter(([key]) => !secretKeys.has(key)))),
    ),
  );
  const parsed = await parsePluginSchema(spec.schema, cloneInertJson(collected));
  if (!parsed.ok) {
    throw new FormSchemaValidationError(
      parsed.issues.map((issue) => ({
        key: typeof issue.path[0] === "string" ? issue.path[0] : "<root>",
        message: issue.message,
      })),
    );
  }
  const validatedEntries = plainRecordEntries(cloneInertJson(parsed.value));
  const validatedKeys = new Set(validatedEntries.map(([key]) => key));
  const boundaryIssues: FormSchemaIssue[] = [];
  for (const [key] of validatedEntries) {
    if (!formKeys.has(key)) boundaryIssues.push({ key, message: "Schema output key is not declared by the form" });
  }
  for (const key of secretKeys) {
    if (secretInputKeys.has(key) && !validatedKeys.has(key)) {
      boundaryIssues.push({ key, message: "Schema output removed or renamed a secret field" });
    }
  }
  if (secretInputKeys.size > 0) {
    for (const [key, value] of validatedEntries) {
      if (secretKeys.has(key)) continue;
      if (!Object.hasOwn(publicInputSnapshot, key) || !jsonSafeEqual(value, publicInputSnapshot[key])) {
        boundaryIssues.push({ key, message: "Schema output changed public data while secrets were present" });
      }
    }
  }
  if (boundaryIssues.length > 0) throw new FormSchemaValidationError(boundaryIssues);
  const publicValues: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};
  for (const [key, value] of validatedEntries) {
    if (secretKeys.has(key)) secrets[key] = value;
    else publicValues[key] = value;
  }
  return { publicValues, secrets };
}
