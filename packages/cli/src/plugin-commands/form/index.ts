import { parsePluginSchema, validateConfigSpec } from "@aio-proxy/core";
import { getLocale } from "@aio-proxy/i18n";
import { type ConfigSpec, type FormField, resolveLocalizedText } from "@aio-proxy/plugin-sdk";
import { confirm, input, password, select } from "@inquirer/prompts";

import {
  FormJsonInvalidError,
  FormNumberInvalidError,
  type FormSchemaIssue,
  FormSchemaValidationError,
} from "./errors";
import { cloneInertJson, compatibleDefault, jsonSafeEqual, plainRecordEntries } from "./json";

export * from "./errors";
export { cloneInertJson } from "./json";

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
  readonly locale?: string;
};

export type RenderConfigSpecResult = {
  readonly publicValues: Record<string, unknown>;
  readonly secrets: Record<string, unknown>;
};

function assertNever(value: never): never {
  throw new Error(`Unsupported form field: ${String(value)}`);
}

function promptMessage(field: FormField, locale: string): string {
  const label = resolveLocalizedText(field.label, locale);
  return field.description === undefined ? label : `${label} (${resolveLocalizedText(field.description, locale)})`;
}

function visible(field: FormField, values: Readonly<Record<string, unknown>>): boolean {
  return field.when === undefined || values[field.when.key] === field.when.equals;
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
  const locale = options.locale ?? getLocale();
  const collected: Record<string, unknown> = Object.fromEntries(
    Object.entries(currentSecrets).filter(([key]) => secretKeys.has(key)),
  );
  const context = options.signal === undefined ? undefined : { signal: options.signal };

  for (const field of spec.form) {
    if (!visible(field, collected)) continue;
    let value: unknown;
    const message = promptMessage(field, locale);
    const current = field.type === "secret" ? currentSecrets[field.key] : currentPublic[field.key];
    const promptDefault = compatibleDefault(field, current);
    switch (field.type) {
      case "text":
        value = await prompts.input(
          {
            message,
            ...(field.placeholder === undefined
              ? {}
              : { placeholder: resolveLocalizedText(field.placeholder, locale) }),
            ...(promptDefault === undefined ? {} : { default: promptDefault as string }),
          },
          context,
        );
        break;
      case "secret":
        value = await prompts.password({ message, mask: "*" }, context);
        if (clearSecrets.has(field.key)) value = undefined;
        else if (value === "") value = current;
        break;
      case "number": {
        const raw = (
          await prompts.input(
            {
              message,
              ...(field.placeholder === undefined
                ? {}
                : { placeholder: resolveLocalizedText(field.placeholder, locale) }),
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
              name: resolveLocalizedText(option.label, locale),
              value: option.value,
              ...(option.description === undefined
                ? {}
                : { description: resolveLocalizedText(option.description, locale) }),
            })),
            ...(promptDefault === undefined ? {} : { default: promptDefault }),
          },
          context,
        );
        break;
      case "json": {
        const raw = (
          await prompts.input(
            {
              message,
              ...(field.placeholder === undefined
                ? {}
                : { placeholder: resolveLocalizedText(field.placeholder, locale) }),
              ...(promptDefault === undefined ? {} : { default: JSON.stringify(promptDefault) }),
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
