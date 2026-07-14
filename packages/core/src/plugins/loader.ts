import { pathToFileURL } from "node:url";
import {
  isPluginDescriptor,
  PLUGIN_API_VERSION,
  PLUGIN_DESCRIPTOR_BRAND,
  type PluginDescriptor,
} from "@aio-proxy/plugin-sdk";
import type { DiagnosticCode, PluginEnablement, PluginState } from "@aio-proxy/types";
import { findInstalledNpmPackage, type NpmPackageInfo } from "../npm";
import { validateConfigSpec } from "./config-spec";
import { type DiagnosticFactory, type PluginLogSink, redactPluginError } from "./diagnostic";
import { createPluginRegistryHost, type PluginRegistry } from "./registry";
import { parsePluginSchema } from "./schema";

export const PLUGIN_IMPORT_TIMEOUT_MS = 10_000;
export const PLUGIN_SETUP_TIMEOUT_MS = 5_000;

export type BuiltInPluginDefinition = {
  readonly packageName: string;
  readonly version: string;
  readonly descriptor: PluginDescriptor<unknown>;
};

export type PluginPackageImporter = (input: {
  readonly packageName: string;
  readonly version: string;
  readonly entrypoint: string;
  readonly attempt: string;
}) => Promise<unknown>;

export type LoadedPluginState = {
  readonly packageName: string;
  readonly version?: string;
  readonly builtIn: boolean;
  readonly state: PluginState;
};

export type PluginRegistrySnapshot = {
  readonly registry: PluginRegistry;
  readonly plugins: ReadonlyMap<string, LoadedPluginState>;
};

export type PluginSecretReader = {
  readonly readPluginSecret: (plugin: string) => unknown | undefined;
};

export type LoadPluginRegistryOptions = {
  readonly enablements: readonly PluginEnablement[];
  readonly builtIns: readonly BuiltInPluginDefinition[];
  readonly diagnostics: DiagnosticFactory;
  readonly importPackage: PluginPackageImporter;
  readonly logger: PluginLogSink;
  readonly secrets: PluginSecretReader;
};

class PluginHostError extends Error {
  readonly code: DiagnosticCode;
  readonly retryable: boolean;

  constructor(code: DiagnosticCode, retryable = false) {
    super("Plugin host operation failed");
    this.name = "PluginHostError";
    this.code = code;
    this.retryable = retryable;
  }
}

const descriptorCache = new Map<string, Promise<PluginDescriptor<unknown>>>();

function isRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Readonly<Record<PropertyKey, unknown>> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmptyRecord(value: unknown): boolean {
  return value === undefined || (isPlainRecord(value) && Reflect.ownKeys(value).length === 0);
}

function stringLeaves(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  const leaves = Object.values(value).flatMap((item) => stringLeaves(item, seen));
  seen.delete(value);
  return leaves;
}

function validateDescriptor(descriptor: unknown): PluginDescriptor<unknown> {
  if (
    isRecord(descriptor) &&
    Reflect.get(descriptor, PLUGIN_DESCRIPTOR_BRAND) === true &&
    Reflect.get(descriptor, "apiVersion") !== PLUGIN_API_VERSION
  ) {
    throw new PluginHostError("PLUGIN_API_INCOMPATIBLE");
  }
  if (!isPluginDescriptor(descriptor)) throw new PluginHostError("PLUGIN_LOAD_FAILED");
  return descriptor as PluginDescriptor<unknown>;
}

function validateImportedModule(value: unknown): PluginDescriptor<unknown> {
  if (!isRecord(value)) throw new PluginHostError("PLUGIN_LOAD_FAILED");
  return validateDescriptor(Reflect.get(value, "default"));
}

function timeout<T>(promise: Promise<T>, milliseconds: number, onTimeout: () => void): Promise<T> {
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new PluginHostError("PLUGIN_LOAD_FAILED", true));
    }, milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function loadThirdPartyDescriptor(
  packageName: string,
  installed: NpmPackageInfo,
  importer: PluginPackageImporter,
): Promise<PluginDescriptor<unknown>> {
  const cacheKey = `${packageName}@${installed.version}`;
  let cached = descriptorCache.get(cacheKey);
  if (cached === undefined) {
    const attempt = crypto.randomUUID();
    const entrypoint = pathToFileURL(installed.entrypoint);
    entrypoint.searchParams.set("aio_proxy_plugin_attempt", attempt);
    const imported = importer({ packageName, version: installed.version, entrypoint: entrypoint.href, attempt });
    cached = timeout(imported, PLUGIN_IMPORT_TIMEOUT_MS, () => {}).then(validateImportedModule);
    descriptorCache.set(cacheKey, cached);
    cached.catch(() => {
      if (descriptorCache.get(cacheKey) === cached) descriptorCache.delete(cacheKey);
    });
  }
  return cached;
}

async function prepareOptions(
  descriptor: PluginDescriptor<unknown>,
  publicOptions: unknown,
  secretOptions: unknown,
): Promise<unknown> {
  const optionsSpec = descriptor.metadata.options;
  if (optionsSpec === undefined) {
    if (!isEmptyRecord(publicOptions) || !isEmptyRecord(secretOptions)) {
      throw new PluginHostError("PLUGIN_OPTIONS_INVALID");
    }
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
  const merged = { ...publicRecord, ...secretRecord };
  const parsed = await parsePluginSchema(spec.schema, merged);
  if (!parsed.ok) throw new PluginHostError("PLUGIN_OPTIONS_INVALID");
  return parsed.value;
}

type Candidate = {
  readonly packageName: string;
  readonly options?: unknown;
  readonly builtIn?: BuiltInPluginDefinition;
};

function candidates(options: LoadPluginRegistryOptions): readonly Candidate[] {
  const enablements = new Map(options.enablements.map((entry) => [entry.packageName, entry]));
  const builtInNames = new Set(options.builtIns.map((definition) => definition.packageName));
  return [
    ...options.builtIns.map((builtIn) => {
      const configured = enablements.get(builtIn.packageName);
      return {
        packageName: builtIn.packageName,
        ...(configured?.options === undefined ? {} : { options: configured.options }),
        builtIn,
      };
    }),
    ...options.enablements.filter((entry) => !builtInNames.has(entry.packageName)),
  ];
}

function failedState(
  options: LoadPluginRegistryOptions,
  packageName: string,
  error: unknown,
  secretValues: readonly string[],
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
    }),
  };
}

export async function loadPluginRegistry(options: LoadPluginRegistryOptions): Promise<PluginRegistrySnapshot> {
  const host = createPluginRegistryHost();
  const plugins = new Map<string, LoadedPluginState>();

  for (const candidate of candidates(options)) {
    const secretOptions = options.secrets.readPluginSecret(candidate.packageName);
    const secretValues = stringLeaves(secretOptions);
    let version: string | undefined;
    try {
      let descriptor: PluginDescriptor<unknown>;
      if (candidate.builtIn === undefined) {
        const installed = await findInstalledNpmPackage(candidate.packageName);
        if (installed === null) throw new PluginHostError("PLUGIN_NOT_INSTALLED");
        version = installed.version;
        descriptor = await loadThirdPartyDescriptor(candidate.packageName, installed, options.importPackage);
      } else {
        version = candidate.builtIn.version;
        descriptor = validateDescriptor(candidate.builtIn.descriptor);
      }

      const pluginOptions = await prepareOptions(descriptor, candidate.options, secretOptions);
      const staging = host.stage(candidate.packageName);
      const setup = Promise.resolve().then(() => descriptor.setup(staging.api, pluginOptions));
      try {
        await timeout(setup, PLUGIN_SETUP_TIMEOUT_MS, staging.seal);
      } catch (error) {
        staging.seal();
        throw error;
      }
      staging.seal();
      staging.commit();
      plugins.set(candidate.packageName, {
        packageName: candidate.packageName,
        ...(version === undefined ? {} : { version }),
        builtIn: candidate.builtIn !== undefined,
        state: { status: "ready" },
      });
    } catch (error) {
      plugins.set(candidate.packageName, {
        packageName: candidate.packageName,
        ...(version === undefined ? {} : { version }),
        builtIn: candidate.builtIn !== undefined,
        state: failedState(options, candidate.packageName, error, secretValues),
      });
    }
  }

  return { registry: host.registry, plugins };
}
