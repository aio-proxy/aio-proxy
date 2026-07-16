import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountCleanupPendingError,
  AtomicConfigFile,
  createPluginRegistryHost,
  ProviderAccountAlreadyExistsError,
  ProviderFingerprintMismatchError,
  ProviderIdCollisionError,
} from "@aio-proxy/core";
import { getLocale, setLocale } from "@aio-proxy/i18n";
import type { OAuthAdapter } from "@aio-proxy/plugin-sdk";
import { zod } from "@aio-proxy/plugin-sdk";
import { formatCliError } from "../src/main";
import { LoopbackPortUnavailableError } from "../src/plugin-commands/loopback";
import {
  createCapabilitySelector,
  createManualOnlyConfirmation,
  createProviderLoginDefaultDeps,
  isProviderLoginUserError,
  ProviderCapabilityAmbiguousError,
  ProviderCapabilityMismatchError,
  ProviderCapabilityNotFoundError,
  type ProviderLoginDeps,
  providerLogin,
} from "../src/plugin-commands/provider-login";

const roots: string[] = [];
const originalLocale = getLocale();
afterEach(async () => {
  await setLocale(originalLocale);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function adapter(id: string): OAuthAdapter {
  return {
    id,
    label: id,
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error("not called");
    },
    catalog: {
      policy: { kind: "static" },
      async discover() {
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
    async createRuntime() {
      throw new Error("not called");
    },
  };
}

function registry() {
  const host = createPluginRegistryHost();
  for (const [plugin, ids] of [
    ["@a/one", ["default", "unique"]],
    ["@b/two", ["default"]],
  ] as const) {
    const staging = host.stage(plugin);
    for (const id of ids) staging.api.oauth.register(adapter(id));
    staging.seal();
    staging.commit();
  }
  return host.registry;
}

function fixture(provider?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "aio-proxy-provider-login-"));
  roots.push(root);
  const path = join(root, "config.json");
  writeFileSync(
    path,
    `${JSON.stringify({ plugins: [], providers: provider === undefined ? {} : { target: provider } })}\n`,
  );
  const calls: unknown[] = [];
  const printed: string[] = [];
  const deps: ProviderLoginDeps = {
    config: new AtomicConfigFile(path),
    repository: {} as ProviderLoginDeps["repository"],
    registry: registry(),
    isTTY: false,
    selectCapability: async (choices) => choices[0]?.reference ?? "",
    renderAccountOptions: async () => ({ publicValues: {}, secrets: {} }),
    createAuthorization: () => ({
      async presentDeviceCode() {},
      async loopback() {
        return { code: "c", redirectUri: "http://localhost" };
      },
    }),
    diagnostics: (code, options) => ({
      code,
      summary: code,
      retryable: options.retryable,
      occurredAt: new Date(0).toISOString(),
    }),
    logger: () => {},
    recover: async () => {
      calls.push("recover");
      return {};
    },
    login: async (input) => {
      calls.push(input);
      return { providerId: "created" };
    },
    print: (line) => printed.push(line),
  };
  return { deps, calls, printed };
}

describe("generic provider login capability resolution", () => {
  test("uses localized capability prompt copy", async () => {
    let message: string | undefined;
    const selectCapability = createCapabilitySelector(async (config) => {
      message = config.message;
      return config.choices[0]?.value ?? "";
    });
    await expect(selectCapability([{ reference: "@a/one#default", label: "First account" }])).resolves.toBe(
      "@a/one#default",
    );
    expect(message).toBe("Select an OAuth capability.");
  });

  test("uses adapter labels for TTY choice names and canonical references for values", async () => {
    await setLocale("zh-Hans");
    let choices: readonly { readonly name: string; readonly value: string }[] = [];
    const selectCapability = createCapabilitySelector(async (config) => {
      choices = config.choices;
      return config.choices[0]?.value ?? "";
    });

    await expect(
      selectCapability([
        {
          reference: "@a/one#default",
          label: { default: "First account", "zh-Hans": "第一个账户" },
        },
      ] as never),
    ).resolves.toBe("@a/one#default");
    expect(choices).toEqual([{ name: "第一个账户", value: "@a/one#default" }]);
  });

  test("manual-only confirmation uses the login signal", async () => {
    const controller = new AbortController();
    let observedConfig: { readonly message: string; readonly default?: boolean } | undefined;
    let observedSignal: AbortSignal | undefined;
    const confirmManualOnly = createManualOnlyConfirmation(controller.signal, async (config, context) => {
      observedConfig = config;
      observedSignal = context?.signal;
      return true;
    });
    await expect(confirmManualOnly("http://127.0.0.1/callback")).resolves.toBe(true);
    expect(observedSignal).toBe(controller.signal);
    expect(observedConfig).toEqual({ message: "http://127.0.0.1/callback", default: false });
  });

  test("accepts canonical references and persists canonical plugin/capability", async () => {
    const state = fixture();
    await providerLogin("@a/one#unique", {}, state.deps);
    expect(state.calls[0]).toBe("recover");
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@a/one", capability: "unique" } });
    expect(state.printed).toEqual(["created"]);
  });

  test("resolves localized progress copy before printing", async () => {
    await setLocale("zh-Hans");
    const state = fixture();
    state.deps = {
      ...state.deps,
      login: async (options) => {
        options.progress?.({ default: "Waiting", "zh-Hans": "等待中" });
        return { providerId: "created" };
      },
    };

    await providerLogin("unique", {}, state.deps);

    expect(state.printed).toEqual(["等待中", "created"]);
  });

  test("contains malformed, accessor-backed, and throwing runtime progress copy", async () => {
    await setLocale("zh-Hans");
    let reads = 0;
    const accessor = { default: "Default" };
    Object.defineProperty(accessor, "zh-Hans", {
      enumerable: true,
      get() {
        reads += 1;
        return "must not print";
      },
    });
    const throwing = new Proxy(
      { default: "Default" },
      {
        get() {
          throw new Error("plugin getter failure");
        },
        getOwnPropertyDescriptor() {
          throw new Error("plugin descriptor failure");
        },
      },
    );
    const state = fixture();
    state.deps = {
      ...state.deps,
      login: async (options) => {
        for (const value of [{ "zh-Hans": "missing default" }, accessor, throwing]) {
          options.progress?.(value as never);
        }
        return { providerId: "created" };
      },
    };

    await expect(providerLogin("unique", {}, state.deps)).resolves.toBeUndefined();
    expect(state.printed).toEqual(["created"]);
    expect(reads).toBe(0);
  });

  test("resolves an unambiguous short capability ID", async () => {
    const state = fixture();
    await providerLogin("unique", {}, state.deps);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@a/one", capability: "unique" } });
  });

  test("lists canonical ambiguity choices in non-interactive mode", async () => {
    const state = fixture();
    await expect(providerLogin("default", {}, state.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "OAuth capability default is ambiguous. Choose one of: @a/one#default, @b/two#default.",
    });
    expect(new ProviderCapabilityAmbiguousError("default", ["@a/one#default"]).references).toEqual(["@a/one#default"]);
  });

  test("uses localized capability and target errors with safe identifiers", async () => {
    expect(new ProviderCapabilityNotFoundError("missing").message).toBe("OAuth capability missing was not found.");
    expect(new ProviderCapabilityMismatchError("@a/one#unique", "@b/two#default").message).toBe(
      "Requested capability @a/one#unique does not match provider capability @b/two#default.",
    );
    const state = fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new AccountCleanupPendingError("target");
      },
    };
    await expect(providerLogin("unique", {}, state.deps)).rejects.toThrow(
      "Provider target is pending account cleanup.",
    );
  });

  test("localizes exhausted Provider ID collisions with the safe candidate", async () => {
    const state = fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new ProviderIdCollisionError("person-deadbeef");
      },
    };
    await expect(providerLogin("unique", {}, state.deps)).rejects.toThrow(
      "Unable to allocate a unique provider ID for person-deadbeef.",
    );
  });

  test("uses interactive selection when omitted or ambiguous", async () => {
    const state = fixture();
    state.deps = { ...state.deps, isTTY: true, selectCapability: async () => "@b/two#default" };
    await providerLogin(undefined, {}, state.deps);
    expect(state.calls[1]).toMatchObject({ capability: { plugin: "@b/two", capability: "default" } });
  });

  test("--provider infers the structured canonical capability and explicit mismatch fails", async () => {
    const provider = { kind: "oauth", plugin: "@a/one", capability: "unique", enabled: true };
    const state = fixture(provider);
    await providerLogin(undefined, { provider: "target" }, state.deps);
    expect(state.calls[1]).toMatchObject({
      targetProviderId: "target",
      capability: { plugin: "@a/one", capability: "unique" },
    });
    await expect(providerLogin("@b/two#default", { provider: "target" }, state.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "Requested capability @b/two#default does not match provider capability @a/one#unique.",
    });
  });

  test("distinguishes missing, invalid, and cleanup-pending provider targets", async () => {
    const state = fixture();
    await expect(providerLogin(undefined, { provider: "target" }, state.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "OAuth provider target was not found.",
    });
    const invalid = fixture({ kind: "api", protocol: "openai-compatible" });
    await expect(providerLogin(undefined, { provider: "target" }, invalid.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "Provider target is not a valid OAuth provider.",
    });
    const pending = fixture({ kind: "oauth", plugin: "@a/one", capability: "unique", enabled: true });
    pending.deps = {
      ...pending.deps,
      login: async () => {
        throw new AccountCleanupPendingError("target");
      },
    };
    await expect(providerLogin(undefined, { provider: "target" }, pending.deps)).rejects.toThrow(
      "Provider target is pending account cleanup.",
    );
    await expect(providerLogin("@missing/pkg#default", {}, state.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "OAuth capability @missing/pkg#default was not found.",
    });
    const unavailable = fixture({ kind: "oauth", plugin: "@missing/pkg", capability: "default", enabled: true });
    await expect(providerLogin(undefined, { provider: "target" }, unavailable.deps)).rejects.toMatchObject({
      name: "ProviderLoginPresentationError",
      message: "OAuth capability @missing/pkg#default was not found.",
    });
  });

  test("duplicate account rebuilds canonical guidance without printing it early", async () => {
    const state = fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new ProviderAccountAlreadyExistsError("existing");
      },
    };
    await expect(providerLogin("unique", {}, state.deps)).rejects.toThrow(
      "An account is already configured as provider existing. Run aio-proxy provider login --provider existing to re-login.",
    );
    expect(state.printed).toEqual([]);
  });

  test("does not print a mutable suggested command before top-level safe rendering", async () => {
    const state = fixture();
    state.deps = {
      ...state.deps,
      login: async () => {
        const error = new ProviderAccountAlreadyExistsError("existing");
        Object.defineProperty(error, "suggestedCommand", { value: "secret extension command" });
        throw error;
      },
    };

    await expect(providerLogin("unique", {}, state.deps)).rejects.toBeInstanceOf(Error);
    expect(state.printed).toEqual([]);
  });

  test("contains a forged core error thrown by the OAuth adapter boundary", async () => {
    const host = createPluginRegistryHost();
    const staging = host.stage("@evil/plugin");
    staging.api.oauth.register({
      ...adapter("default"),
      async login() {
        const error = new ProviderAccountAlreadyExistsError("existing");
        Object.defineProperties(error, {
          existingProviderId: { value: "secret provider", configurable: true },
          suggestedCommand: { value: "secret extension command", configurable: true },
        });
        error.message = "secret extension message";
        throw error;
      },
    });
    staging.seal();
    staging.commit();
    const state = fixture();
    const { login: _login, ...withoutInjectedLogin } = state.deps;
    state.deps = { ...withoutInjectedLogin, registry: host.registry };

    let thrown: unknown;
    try {
      await providerLogin("@evil/plugin#default", {}, state.deps);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ name: "OAuthAdapterLoginError", message: "OAUTH_ADAPTER_LOGIN_FAILED" });
    expect(isProviderLoginUserError(thrown)).toBe(false);
    expect(state.printed).toEqual([]);
  });

  test("preserves a host loopback failure through the adapter boundary and top-level rendering", async () => {
    const host = createPluginRegistryHost();
    const staging = host.stage("@host/login");
    staging.api.oauth.register({
      ...adapter("default"),
      async login(context) {
        try {
          await context.authorization.loopback({
            state: "state",
            redirect: { hostname: "127.0.0.1", port: 1455, path: "/callback" },
            authorizationUrl: ({ redirectUri }) => `https://example.com/authorize?redirect_uri=${redirectUri}`,
            allowManualCallbackUrl: false,
          });
        } catch (error) {
          if (error instanceof Error) {
            error.name = "ForgedHostError";
            error.message = "forged host message";
          }
          throw error;
        }
        throw new Error("unreachable");
      },
    });
    staging.seal();
    staging.commit();
    const state = fixture();
    const { login: _login, ...withoutInjectedLogin } = state.deps;
    state.deps = {
      ...withoutInjectedLogin,
      registry: host.registry,
      createAuthorization: () => ({
        async presentDeviceCode() {},
        async loopback() {
          throw new LoopbackPortUnavailableError(1455);
        },
      }),
    };

    let thrown: unknown;
    try {
      await providerLogin("@host/login#default", {}, state.deps);
    } catch (error) {
      thrown = error;
    }

    expect(formatCliError(thrown, "en").message).toBe("The local callback listener could not use port 1455.");
  });

  test("fingerprint mismatch is localized while the account service owns rollback", async () => {
    const state = fixture({ kind: "oauth", plugin: "@a/one", capability: "unique", enabled: true });
    state.deps = {
      ...state.deps,
      login: async () => {
        throw new ProviderFingerprintMismatchError("target");
      },
    };

    await expect(providerLogin(undefined, { provider: "target" }, state.deps)).rejects.toThrow(
      "The authenticated account does not match provider target.",
    );
    expect(state.printed).toEqual([]);
  });

  test("default dependency creation closes SQLite when registry loading fails", async () => {
    let closes = 0;
    await expect(
      createProviderLoginDefaultDeps({
        config: { read: async () => ({ plugins: [], providers: {} }) } as AtomicConfigFile,
        openDatabase: () =>
          ({
            sqlite: {},
            close() {
              closes += 1;
            },
          }) as never,
        createRepository: () => ({ readPluginSecret: () => null }) as never,
        loadRegistry: async () => {
          throw new Error("setup failed");
        },
      }),
    ).rejects.toThrow("setup failed");
    expect(closes).toBe(1);
  });
});
