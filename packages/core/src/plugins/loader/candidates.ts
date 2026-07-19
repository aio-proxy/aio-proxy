import { type PluginState, pluginConfigCommand } from "@aio-proxy/types";
import { isPlainObject } from "es-toolkit/predicate";

import type { BuiltInPluginDefinition, LoadPluginRegistryOptions } from "./index";

import { validateConfigSpec } from "../config-spec";
import { redactPluginError } from "../diagnostic";
import { parsePluginSchema } from "../schema";
import { type LoadablePluginDescriptor, PluginHostError } from "./descriptor";

export type Candidate = {
  readonly packageName: string;
  readonly options?: unknown;
  readonly builtIn?: BuiltInPluginDefinition;
  readonly configured: boolean;
};

const isPlainRecord = (value: unknown): value is Readonly<Record<PropertyKey, unknown>> => isPlainObject(value);
const isEmptyRecord = (value: unknown) =>
  value === undefined || (isPlainRecord(value) && Reflect.ownKeys(value).length === 0);

export async function prepareOptions(
  descriptor: LoadablePluginDescriptor<unknown>,
  publicOptions: unknown,
  secretOptions: unknown,
): Promise<unknown> {
  const optionsSpec = descriptor.metadata.options;
  if (optionsSpec === undefined) {
    if (!isEmptyRecord(publicOptions) || !isEmptyRecord(secretOptions))
      throw new PluginHostError("PLUGIN_OPTIONS_INVALID");
    return undefined;
  }
  const { spec, secretKeys } = validateConfigSpec(optionsSpec);
  if (publicOptions !== undefined && !isPlainRecord(publicOptions)) throw new PluginHostError("PLUGIN_OPTIONS_INVALID");
  if (secretOptions !== undefined && !isPlainRecord(secretOptions)) throw new PluginHostError("PLUGIN_OPTIONS_INVALID");
  const publicRecord = publicOptions ?? {};
  const secretRecord = secretOptions ?? {};
  for (const secretKey of secretKeys) {
    if (Object.hasOwn(publicRecord, secretKey)) throw new PluginHostError("PLUGIN_OPTIONS_INVALID");
  }
  const parsed = await parsePluginSchema(spec.schema, { ...publicRecord, ...secretRecord });
  if (!parsed.ok) throw new PluginHostError("PLUGIN_OPTIONS_INVALID");
  return parsed.value;
}

export function candidates(options: LoadPluginRegistryOptions): readonly Candidate[] {
  const enablements = new Map(options.enablements.map((entry) => [entry.packageName, entry]));
  const builtInNames = new Set(options.builtIns.map((definition) => definition.packageName));
  return [
    ...options.builtIns.map((builtIn) => {
      const configured = enablements.get(builtIn.packageName);
      return {
        packageName: builtIn.packageName,
        ...(configured?.options === undefined ? {} : { options: configured.options }),
        builtIn,
        configured: configured !== undefined,
      };
    }),
    ...options.enablements
      .filter((entry) => !builtInNames.has(entry.packageName))
      .map((entry) => ({ ...entry, configured: true })),
  ];
}

export function failedState(
  options: LoadPluginRegistryOptions,
  packageName: string,
  error: unknown,
  secretValues: readonly string[],
  configured: boolean,
): PluginState {
  const hostError = error instanceof PluginHostError ? error : new PluginHostError("PLUGIN_LOAD_FAILED");
  options.logger({
    event: "plugin.load.failed",
    code: hostError.code,
    context: { plugin: packageName },
    error: redactPluginError(error, { secretValues }),
  });
  return {
    status: "failed",
    diagnostic: options.diagnostics(hostError.code, {
      plugin: packageName,
      retryable: hostError.retryable,
      ...(configured && (hostError.code === "PLUGIN_LOAD_FAILED" || hostError.code === "PLUGIN_OPTIONS_INVALID")
        ? { suggestedCommand: pluginConfigCommand(packageName) }
        : {}),
    }),
  };
}
