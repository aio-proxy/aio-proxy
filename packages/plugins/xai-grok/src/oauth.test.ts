import { describe, expect, test } from "bun:test";
import type { OAuthLoginContext } from "@aio-proxy/plugin-sdk";
import { currentXAIGrokCredential, loginXAIGrok, refreshXAIGrokCredential, validateXAIEndpoint } from "./oauth";

const DISCOVERY = "https://auth.x.ai/.well-known/openid-configuration";
const DEVICE = "https://auth.x.ai/oauth2/device/code";
const TOKEN = "https://auth.x.ai/oauth2/token";

describe("xAI Grok OAuth", () => {
  test("performs device authorization and returns a stable private identity", async () => {
    const requests: Request[] = [];
    const presented: unknown[] = [];
    const accessToken = jwt({ sub: "subject-1", email: "Person@Example.com" });
    const fetcher = sequenceFetch(requests, [
      Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
      Response.json({
        device_code: "device-1",
        user_code: "CODE-1",
        verification_uri: "https://auth.x.ai/activate",
        verification_uri_complete: "https://auth.x.ai/activate?user_code=CODE-1",
        expires_in: 600,
        interval: 1,
      }),
      Response.json({ error: "authorization_pending" }, { status: 400 }),
      Response.json({ error: "slow_down" }, { status: 400 }),
      Response.json({ access_token: accessToken, refresh_token: "refresh-1", expires_in: 3600 }),
    ]);
    const sleeps: number[] = [];
    const result = await loginXAIGrok(loginContext(presented), {
      fetch: fetcher,
      now: () => 1_700_000_000_000,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      deviceInstructions: "Enter code",
      waitingForAuthorization: "Waiting for xAI authorization",
    });

    expect(requests.map((request) => request.url)).toEqual([DISCOVERY, DEVICE, TOKEN, TOKEN, TOKEN]);
    const deviceRequest = requests[1];
    if (deviceRequest === undefined) throw new Error("device request was not captured");
    expect(Object.fromEntries(await deviceRequest.formData())).toEqual({
      client_id: "b1a00492-073a-47ea-816f-4c329264a828",
      scope: "openid profile email offline_access grok-cli:access api:access",
    });
    expect(presented).toEqual([
      {
        url: "https://auth.x.ai/activate?user_code=CODE-1",
        userCode: "CODE-1",
        instructions: "Enter code CODE-1",
      },
    ]);
    expect(sleeps).toEqual([5_000, 10_000]);
    expect(result).toEqual({
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      suggestedKey: expect.stringMatching(/^grok-[a-f0-9]{12}$/u),
      label: "Person@Example.com",
      credentials: {
        accessToken,
        refreshToken: "refresh-1",
        expiresAt: 1_700_003_600_000,
        email: "Person@Example.com",
        subject: "subject-1",
      },
      expiresAt: 1_700_003_600_000,
    });
  });

  test("rejects discovered endpoints outside x.ai before sending credentials", () => {
    expect(() => validateXAIEndpoint("http://auth.x.ai/token", "token_endpoint")).toThrow("Invalid xAI");
    expect(() => validateXAIEndpoint("https://x.ai.evil.test/token", "token_endpoint")).toThrow("Invalid xAI");
    expect(validateXAIEndpoint(TOKEN, "token_endpoint")).toBe(TOKEN);
  });

  test("propagates cancellation into discovery", async () => {
    const controller = new AbortController();
    const reason = new DOMException("cancelled", "AbortError");
    controller.abort(reason);
    const context = loginContext([]);
    const login = loginXAIGrok(
      { ...context, signal: controller.signal },
      {
        fetch: async (_input, init) => {
          init?.signal?.throwIfAborted();
          throw new Error("aborted discovery must not return");
        },
      },
    );
    await expect(login).rejects.toBe(reason);
  });

  test("stops polling after the device code expires", async () => {
    let now = 0;
    const login = loginXAIGrok(loginContext([]), {
      fetch: sequenceFetch(
        [],
        [
          Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
          Response.json({
            device_code: "device-1",
            user_code: "CODE-1",
            verification_uri: "https://auth.x.ai/activate",
            expires_in: 1,
            interval: 1,
          }),
          Response.json({ error: "authorization_pending" }, { status: 400 }),
        ],
      ),
      now: () => {
        now += 1_000;
        return now;
      },
      sleep: async () => {},
    });
    await expect(login).rejects.toThrow("timed out");
  });

  test("keeps an omitted refresh token and classifies refresh failures", async () => {
    const credential = {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 0,
      email: "person@example.com",
      subject: "subject-1",
    };
    const refreshed = await refreshXAIGrokCredential(credential, {
      fetch: sequenceFetch(
        [],
        [
          Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
          Response.json({ access_token: "new-access", expires_in: 60 }),
        ],
      ),
      now: () => 1_700_000_000_000,
    });
    expect(refreshed).toEqual({ ...credential, accessToken: "new-access", expiresAt: 1_700_000_060_000 });

    const rejected = refreshXAIGrokCredential(credential, {
      fetch: sequenceFetch(
        [],
        [
          Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
          Response.json({ error: "invalid_grant" }, { status: 400 }),
        ],
      ),
    });
    await expect(rejected).rejects.toMatchObject({ retryable: false, options: { reason: "invalid_grant" } });

    const unavailable = refreshXAIGrokCredential(credential, {
      fetch: sequenceFetch(
        [],
        [
          Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
          new Response(null, { status: 503 }),
        ],
      ),
    });
    await expect(unavailable).rejects.toMatchObject({ retryable: true, options: { reason: "upstream_5xx" } });
  });

  test("refreshes through the host credential port inside the five-minute window", async () => {
    let metadata: unknown;
    const expired = { accessToken: "old", refreshToken: "refresh", expiresAt: 0 };
    const value = await currentXAIGrokCredential(
      {
        read: async () => ({ revision: 4, value: expired }),
        refresh: async (revision, exchange) => {
          const updated = await exchange({ revision, value: expired }, new AbortController().signal);
          metadata = updated.metadata;
          return { status: "updated", snapshot: { revision: revision + 1, value: updated.value } };
        },
      },
      {
        fetch: sequenceFetch(
          [],
          [
            Response.json({ device_authorization_endpoint: DEVICE, token_endpoint: TOKEN }),
            Response.json({ access_token: "new", expires_in: 60 }),
          ],
        ),
        now: () => 1_700_000_000_000,
      },
    );
    expect(value.accessToken).toBe("new");
    expect(metadata).toEqual({ expiresAt: 1_700_000_060_000 });
  });
});

function loginContext(presented: unknown[]): OAuthLoginContext {
  return {
    authorization: {
      presentDeviceCode: async (input) => {
        presented.push(input);
      },
      loopback: async () => {
        throw new Error("device flow must not use loopback");
      },
    },
    progress: () => {},
    signal: new AbortController().signal,
  };
}

function sequenceFetch(requests: Request[], responses: Response[]): typeof fetch {
  return async (input, init) => {
    requests.push(new Request(input, init));
    const response = responses.shift();
    if (response === undefined) throw new Error("unexpected request");
    return response;
  };
}

function jwt(payload: object): string {
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(".");
}
