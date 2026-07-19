import {
  AccountCleanupPendingError,
  createPluginRegistryHost,
  ProviderAccountAlreadyExistsError,
  ProviderFingerprintMismatchError,
  ProviderIdCollisionError,
} from "@aio-proxy/core";
import { afterEach, describe, expect, test } from "bun:test";

import { formatCliError } from "../../main";
import { LoopbackPortUnavailableError } from "../loopback";
import {
  isProviderLoginUserError,
  ProviderCapabilityMismatchError,
  ProviderCapabilityNotFoundError,
  providerLogin,
} from "./index";
import { adapter, createProviderLoginTestScope } from "./test-support";

const scope = createProviderLoginTestScope();
afterEach(scope.cleanup);

describe("provider login safe presentation", () => {
  test("uses localized capability and target errors with safe identifiers", async () => {
    expect(new ProviderCapabilityNotFoundError("missing").message).toBe("OAuth capability missing was not found.");
    expect(new ProviderCapabilityMismatchError("@a/one#unique", "@b/two#default").message).toBe(
      "Requested capability @a/one#unique does not match provider capability @b/two#default.",
    );
    const state = scope.fixture();
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
    const state = scope.fixture();
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

  test("duplicate account rebuilds canonical guidance without printing it early", async () => {
    const state = scope.fixture();
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
    const state = scope.fixture();
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
    const state = scope.fixture();
    const { login: _login, ...withoutInjectedLogin } = state.deps;
    state.deps = { ...withoutInjectedLogin, registry: host.registry };
    let thrown: unknown;
    try {
      await providerLogin("@evil/plugin#default", {}, state.deps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "OAuthAuthorizationFailedError",
      message: "AUTHORIZATION_FAILED",
      code: "AUTHORIZATION_FAILED",
      reason: "oauth_adapter",
    });
    expect(isProviderLoginUserError(thrown)).toBe(false);
    expect(state.printed).toEqual([]);
  });

  test("preserves a host loopback failure at the account-login boundary", async () => {
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
    const state = scope.fixture();
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
    expect(thrown).toBeInstanceOf(LoopbackPortUnavailableError);
    expect(thrown).toMatchObject({ port: 1455 });
    expect(formatCliError(thrown, "en").message).toBe("The local callback listener could not use port 1455.");
  });

  test("fingerprint mismatch is localized while the account service owns rollback", async () => {
    const state = scope.fixture({ kind: "oauth", plugin: "@a/one", capability: "unique", enabled: true });
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
});
