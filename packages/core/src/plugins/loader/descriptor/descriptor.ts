import { pathToFileURL } from 'node:url';

import {
  isPluginDescriptor,
  type LocalizedText,
  LocalizedTextSchema,
  PLUGIN_API_VERSIONS_SUPPORTED,
  PLUGIN_DESCRIPTOR_BRAND,
  type PluginDescriptor,
} from '@aio-proxy/plugin-sdk';
import { type DiagnosticCode } from '@aio-proxy/types';

import type { NpmPackageInfo } from '../../../npm';
import type { PluginLogSink } from '../../diagnostic/index';
import { validatePluginIcon } from '../../icon';
import type { PluginPackageImporter } from '../index';

export const PLUGIN_IMPORT_TIMEOUT_MS = 10_000;
export const PLUGIN_SETUP_TIMEOUT_MS = 5_000;

export class PluginHostError extends Error {
  readonly code: DiagnosticCode;
  readonly retryable: boolean;
  constructor(code: DiagnosticCode, retryable = false) {
    super('Plugin host operation failed');
    this.name = 'PluginHostError';
    this.code = code;
    this.retryable = retryable;
  }
}

export type LoadablePluginDescriptor<Options = unknown> = Omit<PluginDescriptor<Options>, 'apiVersion'> & {
  readonly apiVersion: (typeof PLUGIN_API_VERSIONS_SUPPORTED)[number];
};

const descriptorCache = new Map<string, Promise<LoadablePluginDescriptor<unknown>>>();

const supportedApiVersions = new Set<number>(PLUGIN_API_VERSIONS_SUPPORTED);

export function validateDescriptor(
  descriptor: unknown,
  context?: { readonly packageName: string; readonly logger: PluginLogSink },
): LoadablePluginDescriptor<unknown> {
  if (descriptor !== null && typeof descriptor === 'object') {
    const apiVersion = Reflect.get(descriptor, 'apiVersion');
    if (Reflect.has(descriptor, 'apiVersion') && !supportedApiVersions.has(apiVersion as number)) {
      throw new PluginHostError('PLUGIN_API_INCOMPATIBLE');
    }
  }
  if (!isPluginDescriptor(descriptor)) throw new PluginHostError('PLUGIN_LOAD_FAILED');
  const typed = descriptor as LoadablePluginDescriptor<unknown>;
  const displayName = LocalizedTextSchema.safeParse(typed.metadata.displayName);
  const description = LocalizedTextSchema.safeParse(typed.metadata.description);
  const icon = typed.metadata.icon === undefined ? undefined : validatePluginIcon(typed.metadata.icon);
  if (
    (typed.metadata.displayName !== undefined && !displayName.success) ||
    (typed.metadata.description !== undefined && !description.success)
  ) {
    throw new PluginHostError('PLUGIN_LOAD_FAILED');
  }
  if (icon !== undefined && !icon.ok && context !== undefined) {
    try {
      context.logger({
        event: 'plugin.metadata.icon.invalid',
        code: 'PLUGIN_ICON_INVALID',
        context: { plugin: context.packageName },
        error: { name: 'PluginIconValidationError', message: 'Plugin metadata icon was ignored' },
      });
    } catch {}
  }
  return {
    [PLUGIN_DESCRIPTOR_BRAND]: true,
    apiVersion: typed.apiVersion,
    metadata: {
      ...(typed.metadata.displayName === undefined ? {} : { displayName: displayName.data as LocalizedText }),
      ...(typed.metadata.description === undefined ? {} : { description: description.data as LocalizedText }),
      ...(icon?.ok === true ? { icon: icon.value } : {}),
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
  logger: PluginLogSink,
): Promise<LoadablePluginDescriptor<unknown>> {
  const cacheKey = `${packageName}@${installed.version}`;
  let cached = descriptorCache.get(cacheKey);
  if (cached === undefined) {
    const attempt = crypto.randomUUID();
    const entrypoint = pathToFileURL(installed.entrypoint);
    entrypoint.searchParams.set('aio_proxy_plugin_attempt', attempt);
    const imported = importer({ packageName, version: installed.version, entrypoint: entrypoint.href, attempt });
    cached = observedPromiseDeadline(imported, {
      timeoutMs: PLUGIN_IMPORT_TIMEOUT_MS,
      timeoutError: () => new PluginHostError('PLUGIN_LOAD_FAILED', true),
    }).then((value) => {
      if (value === null || typeof value !== 'object') throw new PluginHostError('PLUGIN_LOAD_FAILED');
      return validateDescriptor(Reflect.get(value, 'default'), { packageName, logger });
    });
    descriptorCache.set(cacheKey, cached);
    cached.catch(() => {
      if (descriptorCache.get(cacheKey) === cached) descriptorCache.delete(cacheKey);
    });
  }
  return cached;
}
