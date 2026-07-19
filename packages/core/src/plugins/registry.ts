import { type LocalizedText, LocalizedTextSchema, type OAuthAdapter, type PluginApi } from "@aio-proxy/plugin-sdk";
import { CapabilityIdSchema } from "@aio-proxy/types";
import { validateConfigSpec } from "./config-spec";
import type { PluginLogSink } from "./diagnostic";
import { validateOAuthIcon } from "./icon";
import { isPluginZodSchema } from "./schema";

export type PluginRegistry = {
  readonly resolveOAuth: (plugin: string, capability: string) => OAuthAdapter | undefined;
  readonly oauthCapabilities: () => readonly {
    readonly plugin: string;
    readonly capability: string;
    readonly adapter: OAuthAdapter;
  }[];
};

type OAuthCapability = ReturnType<PluginRegistry["oauthCapabilities"]>[number];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateQuota(value: unknown): NonNullable<OAuthAdapter["quota"]> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Invalid OAuth adapter");
  const { read, reset } = value;
  if (typeof read !== "function" || (reset !== undefined && typeof reset !== "function")) {
    throw new Error("Invalid OAuth adapter");
  }
  const boundRead = read.bind(value) as NonNullable<OAuthAdapter["quota"]>["read"];
  if (reset === undefined) return { read: boundRead };
  return {
    read: boundRead,
    reset: reset.bind(value) as NonNullable<NonNullable<OAuthAdapter["quota"]>["reset"]>,
  };
}

function validateAdapter(
  value: unknown,
  plugin: string,
  logger: PluginLogSink,
): { readonly id: string; readonly adapter: OAuthAdapter } {
  if (!isRecord(value)) throw new Error("Invalid OAuth adapter");
  const { id: rawId, label, description, icon, account, credentials, login, createRuntime, catalog, quota } = value;
  const id = CapabilityIdSchema.parse(rawId);
  const validatedIcon = icon === undefined ? undefined : validateOAuthIcon(icon);
  if (validatedIcon !== undefined && !validatedIcon.ok) {
    try {
      logger({
        event: "plugin.oauth.icon.invalid",
        code: "PLUGIN_ICON_INVALID",
        context: { plugin, capability: id },
        error: { name: "OAuthIconValidationError", message: "OAuth adapter icon was ignored" },
      });
    } catch {}
  }
  const validatedLabel = LocalizedTextSchema.safeParse(label);
  const validatedDescription = LocalizedTextSchema.safeParse(description);
  if (!validatedLabel.success || (description !== undefined && !validatedDescription.success)) {
    throw new Error("Invalid OAuth adapter");
  }
  if (!isRecord(account)) throw new Error("Invalid OAuth adapter");
  const { options } = account;
  const validatedOptions = validateConfigSpec(options).spec;
  if (!isPluginZodSchema(credentials)) throw new Error("Invalid OAuth adapter");
  if (typeof login !== "function" || typeof createRuntime !== "function") throw new Error("Invalid OAuth adapter");
  const validatedQuota = validateQuota(quota);
  if (!isRecord(catalog)) throw new Error("Invalid OAuth adapter");
  const { discover, policy, initialFallback, defaultAliases } = catalog;
  if (
    typeof discover !== "function" ||
    !isRecord(policy) ||
    (initialFallback !== undefined && typeof initialFallback !== "function") ||
    (defaultAliases !== undefined && typeof defaultAliases !== "function")
  ) {
    throw new Error("Invalid OAuth adapter");
  }
  const { kind, ttlMs } = policy;
  if (kind !== "static") {
    if (
      kind !== "ttl" ||
      typeof ttlMs !== "number" ||
      !Number.isFinite(ttlMs) ||
      !Number.isInteger(ttlMs) ||
      ttlMs <= 0
    ) {
      throw new Error("Invalid OAuth adapter");
    }
  }
  return {
    id,
    adapter: {
      id,
      label: validatedLabel.data,
      ...(description === undefined ? {} : { description: validatedDescription.data as LocalizedText }),
      ...(validatedIcon?.ok === true ? { icon: validatedIcon.value } : {}),
      account: { options: validatedOptions },
      credentials: credentials as OAuthAdapter["credentials"],
      login: login.bind(value) as OAuthAdapter["login"],
      catalog: {
        policy: policy as OAuthAdapter["catalog"]["policy"],
        discover: discover.bind(catalog) as OAuthAdapter["catalog"]["discover"],
        ...(initialFallback === undefined
          ? {}
          : {
              initialFallback: initialFallback.bind(catalog) as NonNullable<OAuthAdapter["catalog"]["initialFallback"]>,
            }),
        ...(defaultAliases === undefined
          ? {}
          : { defaultAliases: defaultAliases.bind(catalog) as NonNullable<OAuthAdapter["catalog"]["defaultAliases"]> }),
      },
      createRuntime: createRuntime.bind(value) as OAuthAdapter["createRuntime"],
      ...(validatedQuota === undefined ? {} : { quota: validatedQuota }),
    },
  };
}

export type PluginStagingRegistry = {
  readonly api: PluginApi;
  readonly seal: () => void;
  readonly commit: () => void;
};

const noopPluginLogger: PluginLogSink = () => {};

export function createPluginRegistryHost(logger: PluginLogSink = noopPluginLogger): {
  readonly registry: PluginRegistry;
  readonly stage: (plugin: string) => PluginStagingRegistry;
} {
  const committed = new Map<string, OAuthCapability>();
  const registry: PluginRegistry = {
    resolveOAuth(plugin, capability) {
      return committed.get(`${plugin}\0${capability}`)?.adapter;
    },
    oauthCapabilities() {
      return [...committed.values()];
    },
  };

  return {
    registry,
    stage(plugin) {
      const staged = new Map<string, OAuthCapability>();
      let sealed = false;
      return {
        api: {
          oauth: {
            register(value) {
              if (sealed) throw new Error("Plugin staging registry is sealed");
              const { id, adapter } = validateAdapter(value, plugin, logger);
              if (staged.has(id)) throw new Error("Duplicate OAuth capability");
              staged.set(id, { plugin, capability: id, adapter });
            },
          },
        },
        seal() {
          sealed = true;
        },
        commit() {
          if (!sealed) throw new Error("Plugin staging registry must be sealed before commit");
          for (const capability of staged.values()) {
            committed.set(`${plugin}\0${capability.capability}`, capability);
          }
        },
      };
    },
  };
}
