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

function fieldDefault(field: FormField, current: unknown): unknown {
  if (current !== undefined) return current;
  if (field.type === "boolean" || field.type === "json") return field.defaultValue;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FormSchemaValidationError([{ key: "<root>", message: "Expected an object" }]);
  }
  return value as Record<string, unknown>;
}

export async function renderConfigSpec<T>(
  configSpec: ConfigSpec<T>,
  options: RenderConfigSpecOptions = {},
): Promise<RenderConfigSpecResult> {
  const { spec, secretKeys } = validateConfigSpec<T>(configSpec);
  const prompts = options.prompts ?? defaultPrompts;
  const currentPublic = options.currentPublicValues ?? {};
  const currentSecrets = options.currentSecrets ?? {};
  const clearSecrets = new Set(options.clearSecrets ?? []);
  const collected: Record<string, unknown> = {};
  const context = options.signal === undefined ? undefined : { signal: options.signal };

  for (const field of spec.form) {
    if (!visible(field, collected)) continue;
    let value: unknown;
    const message = promptMessage(field);
    const current = field.type === "secret" ? currentSecrets[field.key] : currentPublic[field.key];
    switch (field.type) {
      case "text":
        value = await prompts.input(
          {
            message,
            ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
            ...(current === undefined ? {} : { default: String(current) }),
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
              ...(current === undefined ? {} : { default: String(current) }),
            },
            context,
          )
        ).trim();
        value = raw === "" ? undefined : Number(raw);
        if (value !== undefined && !Number.isFinite(value)) throw new FormNumberInvalidError(field.key);
        break;
      }
      case "boolean":
        value = await prompts.confirm({ message, default: Boolean(fieldDefault(field, current) ?? false) }, context);
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
            ...(current === undefined ? {} : { default: current }),
          },
          context,
        );
        break;
      case "json": {
        const fallback = fieldDefault(field, current);
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
  const parsed = await parsePluginSchema(spec.schema, collected);
  if (!parsed.ok) {
    throw new FormSchemaValidationError(
      parsed.issues.map((issue) => ({
        key: typeof issue.path[0] === "string" ? issue.path[0] : "<root>",
        message: issue.message,
      })),
    );
  }
  const validated = asRecord(parsed.value);
  const publicValues: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(validated)) {
    if (secretKeys.has(key)) secrets[key] = value;
    else publicValues[key] = value;
  }
  return { publicValues, secrets };
}
