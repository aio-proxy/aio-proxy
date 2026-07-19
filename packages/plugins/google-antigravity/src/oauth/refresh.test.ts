import { type CredentialPort, CredentialRefreshError, type CredentialSnapshot } from "@aio-proxy/plugin-sdk";
import { expect, test } from "bun:test";

import type { GoogleAntigravityCredential } from "../schema";

import { currentGoogleCredential, forceRefreshGoogleCredential, refreshGoogleCredential } from "./refresh";

test("refresh keeps the prior refresh token and project identity", async () => {
  const refreshed = await refreshGoogleCredential(credentialFixture(), {
    fetch: async () => Response.json({ access_token: "new-access", expires_in: 3600, token_type: "Bearer" }),
    now: () => 1_700_000_000_000,
  });
  expect(refreshed).toMatchObject({
    accessToken: "new-access",
    refreshToken: "refresh-1",
    email: "person@example.com",
    projectId: "project-1",
    expiresAt: 1_700_003_600_000,
  });
});

test("refresh sends the Google refresh grant as form data", async () => {
  let request: Request | undefined;
  await refreshGoogleCredential(credentialFixture(), {
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 });
    },
  });
  const body = new URLSearchParams(await request?.clone().text());
  expect(body.get("grant_type")).toBe("refresh_token");
  expect(body.get("refresh_token")).toBe("refresh-1");
});

test("classifies fetch and response-body failures as transient", async () => {
  const network = await refreshError(async () => {
    throw new TypeError("socket failed");
  });
  expect(network.options).toEqual({ retryable: true, reason: "network" });

  const upstream = await refreshError(async () => new Response("upstream-secret", { status: 503 }));
  expect(upstream.options).toEqual({ retryable: true, reason: "upstream_5xx", status: 503 });

  const bodyTimeout = await refreshError(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException("Timed out", "AbortError"));
          },
        }),
      ),
  );
  expect(bodyTimeout.options).toEqual({ retryable: true, reason: "network" });
});

test.each([
  [408, { error: "temporarily_unavailable" }, true, "request_timeout"],
  [429, { error: "rate_limited" }, true, "rate_limited"],
  [500, { error: "server_error" }, true, "upstream_5xx"],
  [400, { error: "invalid_request" }, false, "request_rejected"],
  [401, { error: "invalid_client" }, false, "credential_rejected"],
  [403, { error: "access_denied" }, false, "credential_rejected"],
  [400, { error: "invalid_grant" }, false, "invalid_grant"],
  [400, { error: "access_denied", error_description: "Token has been revoked" }, false, "invalid_grant"],
] as const)("classifies HTTP %i %s as retryable=%s reason=%s", async (status, payload, retryable, reason) => {
  const error = await refreshError(async () => Response.json(payload, { status }));
  expect(error.options).toEqual({ retryable, reason, status });
  expect(errorSurface(error)).not.toContain(JSON.stringify(payload));
});

test("invalid refresh payloads are terminal without exposing credential material", async () => {
  const credential = credentialFixture();
  const error = await rejected(
    refreshGoogleCredential(credential, {
      fetch: async () =>
        Response.json({
          access_token: "",
          refresh_token: "raw-refresh-secret",
          email: "raw@example.com",
          raw: "raw-token-response-secret",
        }),
    }),
  );

  expect(error).toBeInstanceOf(CredentialRefreshError);
  expect((error as CredentialRefreshError).options).toEqual({ retryable: false, reason: "invalid_payload" });
  expect(errorSurface(error)).not.toMatch(
    /access-1|refresh-1|person@example.com|raw-refresh-secret|raw@example.com|raw-token-response-secret/u,
  );
});

test("primitive and array refresh payloads are terminal invalid payloads", async () => {
  for (const payload of [null, [], "raw-token-response-secret"]) {
    const error = await rejected(
      refreshGoogleCredential(credentialFixture(), { fetch: async () => Response.json(payload) }),
    );

    expect(error).toBeInstanceOf(CredentialRefreshError);
    expect((error as CredentialRefreshError).options).toEqual({ retryable: false, reason: "invalid_payload" });
    expect(errorSurface(error)).not.toContain("raw-token-response-secret");
  }
});

test("current credential refreshes only inside the five-minute window", async () => {
  const fresh = credentialFixture({ expiresAt: 1_700_000_600_001 });
  const state = memoryPort(fresh);
  const snapshot = await currentGoogleCredential(state.port, {
    now: () => 1_700_000_300_000,
    fetch: async () => {
      throw new Error("must not fetch");
    },
  });
  expect(snapshot).toEqual({ value: fresh, revision: 1 });
  expect(state.refreshes()).toBe(0);
});

test("force refresh returns the winning superseded snapshot", async () => {
  const original = credentialFixture();
  const winner = credentialFixture({ accessToken: "winner", expiresAt: 99 });
  const port: CredentialPort<GoogleAntigravityCredential> = {
    read: async () => ({ value: original, revision: 1 }),
    refresh: async () => ({ status: "superseded", snapshot: { value: winner, revision: 2 } }),
  };

  await expect(forceRefreshGoogleCredential(port, { fetch: async () => Response.json({}) })).resolves.toEqual({
    value: winner,
    revision: 2,
  });
});

function credentialFixture(overrides: Partial<GoogleAntigravityCredential> = {}): GoogleAntigravityCredential {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1_700_000_000_000,
    email: "person@example.com",
    projectId: "project-1",
    ...overrides,
  };
}

function memoryPort(original: GoogleAntigravityCredential): {
  readonly port: CredentialPort<GoogleAntigravityCredential>;
  readonly refreshes: () => number;
} {
  let snapshot: CredentialSnapshot<GoogleAntigravityCredential> = { value: original, revision: 1 };
  let count = 0;
  return {
    refreshes: () => count,
    port: {
      read: async () => snapshot,
      refresh: async (_revision, exchange) => {
        count += 1;
        const exchanged = await exchange(snapshot, new AbortController().signal);
        snapshot = { value: exchanged.value, revision: snapshot.revision + 1 };
        return { status: "updated", snapshot };
      },
    },
  };
}

async function refreshError(fetch: typeof globalThis.fetch): Promise<CredentialRefreshError> {
  const error = await rejected(refreshGoogleCredential(credentialFixture(), { fetch }));
  if (!(error instanceof CredentialRefreshError)) throw error;
  return error;
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
