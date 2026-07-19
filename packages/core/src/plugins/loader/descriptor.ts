import type { DiagnosticCode } from "@aio-proxy/types";

import {
  isPluginDescriptor,
  type LocalizedText,
  LocalizedTextSchema,
  PLUGIN_API_VERSIONS_SUPPORTED,
  PLUGIN_DESCRIPTOR_BRAND,
  type PluginDescriptor,
} from "@aio-proxy/plugin-sdk";
import { pathToFileURL } from "node:url";

import type { NpmPackageInfo } from "../../npm";
import type { PluginPackageImporter } from "./index";

export const PLUGIN_IMPORT_TIMEOUT_MS = 10_000;
export const PLUGIN_SETUP_TIMEOUT_MS = 5_000;

export class PluginHostError extends Error {
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
const isRecord = (value: unknown): value is Readonly<Record<PropertyKey, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const supportedApiVersions = new Set<number>(PLUGIN_API_VERSIONS_SUPPORTED);

export function validateDescriptor(descriptor: unknown): PluginDescriptor<unknown> {
  if (isRecord(descriptor)) {
    const apiVersion = Reflect.get(descriptor, "apiVersion");
    if (Number.isInteger(apiVersion) && !supportedApiVersions.has(apiVersion as number)) {
      throw new PluginHostError("PLUGIN_API_INCOMPATIBLE");
    }
  }
  if (!isPluginDescriptor(descriptor)) throw new PluginHostError("PLUGIN_LOAD_FAILED");
  const typed = descriptor as PluginDescriptor<unknown>;
  const label = LocalizedTextSchema.safeParse(typed.metadata.label);
  const description = LocalizedTextSchema.safeParse(typed.metadata.description);
  if (
    (typed.metadata.label !== undefined && !label.success) ||
    (typed.metadata.description !== undefined && !description.success)
  ) {
    throw new PluginHostError("PLUGIN_LOAD_FAILED");
  }
  return {
    [PLUGIN_DESCRIPTOR_BRAND]: true,
    apiVersion: typed.apiVersion,
    metadata: {
      ...(typed.metadata.label === undefined ? {} : { label: label.data as LocalizedText }),
      ...(typed.metadata.description === undefined ? {} : { description: description.data as LocalizedText }),
      ...(typed.metadata.options === undefined ? {} : { options: typed.metadata.options }),
    },
    setup: typed.setup,
  };
}

export type ObservedPromiseDeadlineOptions = {
  readonly timeoutMs: number;
  readonly timeoutError: () => Error;
  readonly onTimeout?: () => void;
};

export function observedPromiseDeadline<T>(promise: Promise<T>, options: ObservedPromiseDeadlineOptions): Promise<T> {
  promise.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      options.onTimeout?.();
      reject(options.timeoutError());
    }, options.timeoutMs);
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

export async function loadThirdPartyDescriptor(
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
    cached = observedPromiseDeadline(imported, {
      timeoutMs: PLUGIN_IMPORT_TIMEOUT_MS,
      timeoutError: () => new PluginHostError("PLUGIN_LOAD_FAILED", true),
    }).then((value) => {
      if (!isRecord(value)) throw new PluginHostError("PLUGIN_LOAD_FAILED");
      return validateDescriptor(Reflect.get(value, "default"));
    });
    descriptorCache.set(cacheKey, cached);
    cached.catch(() => {
      if (descriptorCache.get(cacheKey) === cached) descriptorCache.delete(cacheKey);
    });
  }
  return cached;
}
