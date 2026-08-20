import type { ConfigSpec } from '../config';
import type { LocalizedText } from '../localized-text';
import type { Logger } from '../logger';
import type { OAuthAdapter } from '../oauth';

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_API_VERSIONS_SUPPORTED = [1] as const;
export const PLUGIN_DESCRIPTOR_BRAND = Symbol.for('@aio-proxy/plugin-sdk/descriptor/v1');

export type LobeIconKey = AioProxyLobeIconKey;

// oxlint-disable-next-line typescript/no-redundant-type-constituents -- LobeIconKey is a literal-key union at build time (a `string` placeholder only during lint), so the URL/data-URI members are not redundant and are required to reject arbitrary strings.
export type PluginIcon = LobeIconKey | `http://${string}` | `https://${string}` | `data:image/${string}`;

export type PluginMetadata<Options = undefined> = {
  readonly displayName?: LocalizedText;
  readonly description?: LocalizedText;
  readonly icon?: PluginIcon;
  readonly options?: ConfigSpec<Options>;
};

export type PluginApi = {
  readonly oauth: {
    readonly register: <Options, Credential>(adapter: OAuthAdapter<Options, Credential>) => void;
  };
  readonly logger: Logger;
};

export type PluginDescriptor<Options = undefined> = {
  readonly [PLUGIN_DESCRIPTOR_BRAND]: true;
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly metadata: PluginMetadata<Options>;
  readonly setup: (api: PluginApi, options: Options) => void | Promise<void>;
};

export type PluginDescriptorShell = {
  readonly [PLUGIN_DESCRIPTOR_BRAND]: true;
  readonly apiVersion: (typeof PLUGIN_API_VERSIONS_SUPPORTED)[number];
  readonly metadata: {
    readonly displayName?: unknown;
    readonly description?: unknown;
    readonly icon?: unknown;
    readonly options?: unknown;
  };
  readonly setup: unknown;
};

export function definePlugin<Options = undefined>(
  setup: PluginDescriptor<Options>['setup'],
  metadata: PluginDescriptor<Options>['metadata'] = {},
): PluginDescriptor<Options> {
  return Object.freeze({
    [PLUGIN_DESCRIPTOR_BRAND]: true as const,
    apiVersion: PLUGIN_API_VERSION,
    metadata,
    setup,
  });
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPluginDescriptor(value: unknown): value is PluginDescriptorShell {
  if (!isObject(value)) {
    return false;
  }

  const apiVersion = Reflect.get(value, 'apiVersion');
  const metadata = Reflect.get(value, 'metadata');
  return (
    Reflect.get(value, PLUGIN_DESCRIPTOR_BRAND) === true &&
    apiVersion === PLUGIN_API_VERSION &&
    isObject(metadata) &&
    typeof Reflect.get(value, 'setup') === 'function'
  );
}
