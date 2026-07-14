import type { ConfigSpec } from "./config";
import type { OAuthAdapter } from "./oauth";

export const PLUGIN_API_VERSION = 1 as const;
export const PLUGIN_DESCRIPTOR_BRAND = Symbol.for("@aio-proxy/plugin-sdk/descriptor/v1");

export type PluginApi = {
  readonly oauth: {
    readonly register: <Options, Credential>(adapter: OAuthAdapter<Options, Credential>) => void;
  };
};

export type PluginDescriptor<Options = undefined> = {
  readonly [PLUGIN_DESCRIPTOR_BRAND]: true;
  readonly apiVersion: typeof PLUGIN_API_VERSION;
  readonly metadata: { readonly options?: ConfigSpec<Options> };
  readonly setup: (api: PluginApi, options: Options) => void | Promise<void>;
};

export function definePlugin<Options = undefined>(
  setup: PluginDescriptor<Options>["setup"],
  metadata: PluginDescriptor<Options>["metadata"] = {},
): PluginDescriptor<Options> {
  return Object.freeze({
    [PLUGIN_DESCRIPTOR_BRAND]: true as const,
    apiVersion: PLUGIN_API_VERSION,
    metadata,
    setup,
  });
}

export function isPluginDescriptor(value: unknown): value is PluginDescriptor<unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const metadata = Reflect.get(value, "metadata");
  return (
    Reflect.get(value, PLUGIN_DESCRIPTOR_BRAND) === true &&
    Reflect.get(value, "apiVersion") === PLUGIN_API_VERSION &&
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    typeof Reflect.get(value, "setup") === "function"
  );
}
