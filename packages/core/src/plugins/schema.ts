import type { ZodType } from "@aio-proxy/plugin-sdk";

export type PluginSchemaValidation<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly issues: readonly {
        readonly message: string;
        readonly path: readonly (string | number)[];
      }[];
    };

const CONTRACT_ERROR_MESSAGE = "Plugin schema contract is invalid";

export class PluginSchemaContractError extends Error {
  constructor() {
    super(CONTRACT_ERROR_MESSAGE);
    this.name = "PluginSchemaContractError";
  }
}

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPluginZodSchema(value: unknown): value is ZodType<unknown> {
  return (
    isRecord(value) &&
    typeof Reflect.get(value, "safeParse") === "function" &&
    typeof Reflect.get(value, "safeParseAsync") === "function"
  );
}

function normalizePath(value: unknown): readonly (string | number)[] {
  if (!Array.isArray(value)) {
    throw new PluginSchemaContractError();
  }
  return value.map((segment) =>
    typeof segment === "string" || (typeof segment === "number" && Number.isFinite(segment)) ? segment : "<unknown>",
  );
}

export async function parsePluginSchema<T>(schema: ZodType<T>, value: unknown): Promise<PluginSchemaValidation<T>> {
  if (!isPluginZodSchema(schema)) {
    throw new PluginSchemaContractError();
  }

  let result: unknown;
  try {
    result = await schema.safeParseAsync(value);
  } catch {
    throw new PluginSchemaContractError();
  }

  if (!isRecord(result)) {
    throw new PluginSchemaContractError();
  }
  const { success } = result;
  if (typeof success !== "boolean") throw new PluginSchemaContractError();
  if (success) {
    if (!("data" in result)) throw new PluginSchemaContractError();
    const { data } = result;
    return { ok: true, value: data as T };
  }

  const { error } = result;
  if (!isRecord(error)) throw new PluginSchemaContractError();
  const { issues: rawIssues } = error;
  if (!Array.isArray(rawIssues) || rawIssues.length === 0) throw new PluginSchemaContractError();
  const issues = rawIssues.map((issue) => {
    if (!isRecord(issue)) throw new PluginSchemaContractError();
    const { message, path } = issue;
    if (typeof message !== "string") throw new PluginSchemaContractError();
    return { message, path: normalizePath(path) };
  });
  return { ok: false, issues };
}
