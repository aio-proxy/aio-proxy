import type { LoopbackRequest } from "@aio-proxy/plugin-sdk";
import { createAccount, expect, fixture, loginOAuthAccount, options, registry, test } from "./test-support";

test("rethrows host authorization failures by identity", async () => {
  const state = fixture();
  const failure = new Error("host authorization failed");
  const error = await rejected(
    createAccount(state, {
      createAuthorization: () => ({
        async presentDeviceCode() {},
        async loopback() {
          throw failure;
        },
      }),
      registry: registry({
        login: async ({ authorization }) => {
          await authorization.loopback(loopbackRequest());
          throw new Error("unreachable");
        },
      }),
    }),
  );

  expect(error).toBe(failure);
});

test("maps an adapter-thrown host error lookalike to safe AUTHORIZATION_FAILED metadata", async () => {
  const lookalike = Object.assign(new Error("HOST_AUTHORIZATION_FAILED"), {
    name: "LoopbackPortUnavailableError",
    port: 1455,
  });
  const error = await rejected(
    createAccount(fixture(), {
      registry: registry({
        login: async () => {
          throw lookalike;
        },
      }),
    }),
  );

  expect(error).not.toBe(lookalike);
  expect(error).toMatchObject({
    name: "OAuthAuthorizationFailedError",
    message: "AUTHORIZATION_FAILED",
    code: "AUTHORIZATION_FAILED",
    reason: "oauth_adapter",
    detail: "OAUTH_ADAPTER_LOGIN_FAILED",
  });
});

test("maps plugin token, userinfo, and project failures to safe AUTHORIZATION_FAILED metadata", async () => {
  for (const message of [
    "token exchange failed authorization-code-secret raw-token-response-secret",
    "userinfo failed access-token-secret private@example.com",
    "project initialization failed refresh-token-secret raw-project-body-secret",
  ]) {
    const error = await rejected(
      createAccount(fixture(), {
        registry: registry({
          login: async () => {
            throw new Error(message);
          },
        }),
      }),
    );

    expect(error).toMatchObject({
      name: "OAuthAuthorizationFailedError",
      message: "AUTHORIZATION_FAILED",
      code: "AUTHORIZATION_FAILED",
      reason: "oauth_adapter",
      detail: "OAUTH_ADAPTER_LOGIN_FAILED",
    });
    expect(errorSurface(error)).not.toMatch(
      /authorization-code-secret|raw-token-response-secret|access-token-secret|private@example.com|refresh-token-secret|raw-project-body-secret/u,
    );
  }
});

test("authorization failure preserves the old account revision", async () => {
  const state = fixture();
  await createAccount(state);
  await expect(
    loginOAuthAccount(
      options(state, {
        targetProviderId: "person",
        capability: undefined,
        registry: registry({ login: async () => Promise.reject(new Error("denied")) }),
      }),
    ),
  ).rejects.toMatchObject({
    name: "OAuthAuthorizationFailedError",
    message: "AUTHORIZATION_FAILED",
    code: "AUTHORIZATION_FAILED",
    reason: "oauth_adapter",
  });
  expect(state.repository.readAccount("person")).toMatchObject({ revision: 1, runtimeRevision: 1 });
});

test("authorization rejection preserves undefined by identity", async () => {
  const state = fixture();
  const outcome = await loginOAuthAccount(
    options(state, {
      createAuthorization: () => ({
        async presentDeviceCode() {
          throw undefined;
        },
        async loopback() {
          return { code: "unused", redirectUri: "http://127.0.0.1/callback" };
        },
      }),
      registry: registry({
        login: async ({ authorization }) => {
          await authorization.presentDeviceCode({
            url: "https://identity.example/device",
            userCode: "CODE",
            instructions: "Authorize",
          });
          throw new Error("unreachable");
        },
      }),
    }),
  ).then(
    () => ({ status: "fulfilled" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );

  expect(outcome).toMatchObject({
    status: "rejected",
    error: undefined,
  });
});

function loopbackRequest(): LoopbackRequest {
  return {
    state: "state-secret",
    redirect: { hostname: "localhost", port: 51121, path: "/oauth-callback" },
    authorizationUrl: ({ redirectUri }) => `https://example.test/auth?redirect_uri=${redirectUri}`,
    allowManualCallbackUrl: true,
  };
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error("expected an Error rejection");
  }
  throw new Error("expected promise to reject");
}

function errorSurface(error: Error): string {
  return [error.message, ...Object.values(error), JSON.stringify(error)].join(" ");
}
