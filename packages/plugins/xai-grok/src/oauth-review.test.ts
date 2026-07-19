import { expect, test } from "bun:test";
import type { OAuthLoginContext } from "@aio-proxy/plugin-sdk";
import { currentXAIGrokCredential, loginXAIGrok, refreshXAIGrokCredential } from "./oauth";

const DEVICE = "https://auth.x.ai/oauth2/device/code";
const TOKEN = "https://auth.x.ai/oauth2/token";

test("treats invalid_grant as non-retryable regardless of HTTP status", async () => {
  const refresh = refreshXAIGrokCredential(credential(), {
    fetch: sequenceFetch([
      Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
      Response.json({ error: "invalid_grant" }, { status: 503 }),
    ]),
  });

  await expect(refresh).rejects.toMatchObject({
    retryable: false,
    options: { reason: "invalid_grant", status: 503 },
  });
});

test("does not refresh after the caller aborts following credential read", async () => {
  const controller = new AbortController();
  const reason = new DOMException("cancelled", "AbortError");
  const existing = credential();
  let resolveRead = (_value: { revision: number; value: typeof existing }) => {};
  const read = new Promise<{ revision: number; value: typeof existing }>((resolve) => {
    resolveRead = resolve;
  });
  let refreshCalls = 0;
  const current = currentXAIGrokCredential(
    {
      read: () => read,
      refresh: async () => {
        refreshCalls++;
        return { status: "updated", snapshot: { revision: 2, value: existing } };
      },
    },
    { signal: controller.signal },
  );

  resolveRead({ revision: 1, value: existing });
  queueMicrotask(() => controller.abort(reason));

  await expect(current).rejects.toBe(reason);
  expect(refreshCalls).toBe(0);
});

test("continues device polling after retryable network and HTTP failures", async () => {
  const sleeps: number[] = [];
  const result = await loginXAIGrok(loginContext(), {
    fetch: sequenceFetch([
      Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
      Response.json({
        device_code: "device-1",
        user_code: "CODE-1",
        verification_uri: "https://auth.x.ai/activate",
        expires_in: 60,
        interval: 1,
      }),
      new TypeError("temporary network failure"),
      new Response("gateway unavailable", { status: 502 }),
      Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 }),
    ]),
    now: () => 0,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
  });

  expect(sleeps).toEqual([5_000, 5_000]);
  expect(result.credentials.accessToken).toBe("new-access");
});

function credential() {
  return { accessToken: "old", refreshToken: "refresh", expiresAt: 0 };
}

function sequenceFetch(responses: (Error | Response)[]): typeof fetch {
  return async () => {
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    if (response instanceof Error) throw response;
    return response;
  };
}

function loginContext(): OAuthLoginContext {
  return {
    authorization: {
      presentDeviceCode: async () => {},
      loopback: async () => {
        throw new Error("device flow must not use loopback");
      },
    },
    progress: () => {},
    signal: new AbortController().signal,
  };
}
