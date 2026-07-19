import { describe, expect, test } from "bun:test";
import { type CredentialPort, CredentialRefreshError, type OAuthLoginContext } from "@aio-proxy/plugin-sdk";
import { kimiClientId } from "../rslib.config";
import { currentKimiCredential, type KimiCredential, loginKimi, refreshKimiCredential } from "./oauth";

type FetchCall = { readonly url: string; readonly init?: RequestInit };
type RefreshExchange = Parameters<CredentialPort<KimiCredential>["refresh"]>[1];

const presentation = { instructions: "Open Kimi", waiting: "Waiting" } as const;

function sequence(responses: readonly (Response | Error)[], calls: FetchCall[] = []): typeof fetch {
  let index = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const response = responses[index++];
    if (response instanceof Error) throw response;
    if (response === undefined) throw new Error("Unexpected fetch");
    return response;
  }) as typeof fetch;
}

function loginContext(
  presented: Parameters<OAuthLoginContext["authorization"]["presentDeviceCode"]>[0][] = [],
  progress: unknown[] = [],
  signal: AbortSignal = new AbortController().signal,
): OAuthLoginContext {
  return {
    signal,
    progress: (message) => progress.push(message),
    authorization: {
      presentDeviceCode: async (input) => {
        presented.push(input);
      },
      loopback: async () => {
        throw new Error("Unexpected loopback login");
      },
    },
  };
}

function deviceResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    device_code: "device-code",
    user_code: "ABCD",
    verification_uri: "https://kimi.test/device",
    expires_in: 900,
    interval: 2,
    ...overrides,
  });
}

function form(call: FetchCall): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.init?.body as string));
}

function firstCall(calls: readonly FetchCall[]): FetchCall {
  if (calls[0] === undefined) throw new Error("Expected fetch call");
  return calls[0];
}

test("polls pending and slow device authorization in request order", async () => {
  const calls: FetchCall[] = [];
  const waits: number[] = [];
  const progress: unknown[] = [];
  const presented: Parameters<OAuthLoginContext["authorization"]["presentDeviceCode"]>[0][] = [];
  const result = await loginKimi(loginContext(presented, progress), presentation, {
    deviceId: () => "device-1",
    now: () => 1_700_000_000_000,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetch: sequence(
      [
        deviceResponse(),
        Response.json({ error: "authorization_pending" }, { status: 400 }),
        Response.json({ error: "slow_down", interval: 10 }, { status: 400 }),
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
      ],
      calls,
    ),
  });

  expect(calls.map(({ url }) => url)).toEqual([
    "https://auth.kimi.com/api/oauth/device_authorization",
    "https://auth.kimi.com/api/oauth/token",
    "https://auth.kimi.com/api/oauth/token",
    "https://auth.kimi.com/api/oauth/token",
  ]);
  expect(form(firstCall(calls))).toEqual({ client_id: kimiClientId });
  expect(calls.slice(1).map(form)).toEqual(
    Array.from({ length: 3 }, () => ({
      client_id: kimiClientId,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "device-code",
    })),
  );
  expect(waits).toEqual([2_000, 10_000]);
  expect(progress).toEqual(["Waiting"]);
  expect(presented[0]?.url).toBe("https://kimi.test/device");
  expect(result).toMatchObject({
    suggestedKey: expect.stringMatching(/^kimi-[0-9a-f]{12}$/u),
    label: "Kimi Code",
    credentials: { accessToken: "access", refreshToken: "refresh", deviceId: "device-1" },
    expiresAt: 1_700_003_600_000,
  });
});

test("presents the complete verification URL and appends code to localized instructions", async () => {
  const presented: Parameters<OAuthLoginContext["authorization"]["presentDeviceCode"]>[0][] = [];
  await loginKimi(
    loginContext(presented),
    { ...presentation, instructions: { default: "Open", "zh-CN": "打开" } },
    {
      deviceId: () => "device-1",
      now: () => 0,
      fetch: sequence([
        deviceResponse({ verification_uri_complete: "https://kimi.test/device?code=ABCD" }),
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 1 }),
      ]),
    },
  );
  expect(presented).toEqual([
    {
      url: "https://kimi.test/device?code=ABCD",
      userCode: "ABCD",
      instructions: { default: "Open\n\nABCD", "zh-CN": "打开\n\nABCD" },
    },
  ]);
});

test("classifies denied and timed-out device authorization", async () => {
  await expect(
    loginKimi(loginContext(), presentation, {
      deviceId: () => "device-1",
      now: () => 0,
      fetch: sequence([deviceResponse(), Response.json({ error: "access_denied" })]),
    }),
  ).rejects.toThrow("Kimi device authorization denied");

  const times = [0, 0, 1_001];
  await expect(
    loginKimi(loginContext(), presentation, {
      deviceId: () => "device-1",
      now: () => times.shift() ?? 1_001,
      sleep: async () => {},
      fetch: sequence([deviceResponse({ expires_in: 1 }), Response.json({ error: "authorization_pending" })]),
    }),
  ).rejects.toThrow("Kimi device authorization timed out");
});

test("passes cancellation through polling sleep", async () => {
  const controller = new AbortController();
  await expect(
    loginKimi(loginContext([], [], controller.signal), presentation, {
      deviceId: () => "device-1",
      now: () => 0,
      fetch: sequence([deviceResponse(), Response.json({ error: "authorization_pending" })]),
      sleep: async (_milliseconds, signal) => {
        controller.abort(new Error("stopped"));
        signal.throwIfAborted();
      },
    }),
  ).rejects.toThrow("stopped");
});

test.each([408, 429, 500])("retries transient token HTTP %i without parsing its body", async (status) => {
  const calls: FetchCall[] = [];
  const waits: number[] = [];
  const result = await loginKimi(loginContext(), presentation, {
    deviceId: () => "device-1",
    now: () => 0,
    sleep: async (milliseconds) => waits.push(milliseconds),
    fetch: sequence(
      [
        deviceResponse(),
        new Response("not-json", { status }),
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
      ],
      calls,
    ),
  });
  expect(result.credentials.accessToken).toBe("access");
  expect(waits).toEqual([2_000]);
  expect(calls).toHaveLength(3);
});

test.each([
  { access_token: "server-access", expires_in: 3_600 },
  { access_token: "server-access", refresh_token: "server-refresh" },
])("rejects incomplete initial tokens without exposing response fields", async (token) => {
  let error: unknown;
  try {
    await loginKimi(loginContext(), presentation, {
      deviceId: () => "device-1",
      now: () => 0,
      fetch: sequence([deviceResponse(), Response.json({ ...token, diagnostic: "server-secret-body" })]),
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toBe("Error: Kimi OAuth token response is invalid");
  expect(String(error)).not.toContain("server-access");
  expect(String(error)).not.toContain("server-secret-body");
});

describe("credential refresh", () => {
  const current: KimiCredential = {
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 0,
    deviceId: "device-1",
  };

  test.each([undefined, "new-refresh"])("preserves or rotates the refresh token", async (refreshToken) => {
    const calls: FetchCall[] = [];
    const refreshed = await refreshKimiCredential(current, {
      now: () => 1_000,
      fetch: sequence(
        [
          Response.json({
            access_token: "new-access",
            ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
            expires_in: 60,
          }),
        ],
        calls,
      ),
    });
    expect(refreshed).toEqual({
      accessToken: "new-access",
      refreshToken: refreshToken ?? "old-refresh",
      expiresAt: 61_000,
      deviceId: "device-1",
    });
    expect(form(firstCall(calls))).toEqual({
      client_id: kimiClientId,
      grant_type: "refresh_token",
      refresh_token: "old-refresh",
    });
  });

  test.each([
    [401, false, "rejected"],
    [403, false, "rejected"],
    [429, true, "http"],
    [500, true, "http"],
  ] as const)("classifies HTTP %i refresh failures", async (status, retryable, reason) => {
    const error = await refreshKimiCredential(current, {
      fetch: sequence([new Response("server-secret-body", { status })]),
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CredentialRefreshError);
    expect(error).toMatchObject({ retryable, options: { reason, status } });
    expect(String(error)).not.toContain("server-secret-body");
    expect(String(error)).not.toContain("old-refresh");
  });

  test("classifies network refresh failures as retryable", async () => {
    const error = await refreshKimiCredential(current, { fetch: sequence([new Error("network-secret")]) }).catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(CredentialRefreshError);
    expect(error).toMatchObject({ retryable: true, options: { reason: "network" } });
    expect(String(error)).not.toContain("network-secret");
  });

  test("classifies malformed successful refresh responses without exposing their body", async () => {
    const error = await refreshKimiCredential(current, {
      fetch: sequence([new Response("server-secret-body")]),
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(CredentialRefreshError);
    expect(error).toMatchObject({ retryable: false, options: { reason: "invalid" } });
    expect(String(error)).not.toContain("server-secret-body");
  });

  test("reuses fresh credentials and refreshes credentials near expiry", async () => {
    const freshPort = { read: async () => ({ value: { ...current, expiresAt: 400_001 }, revision: 1 }) };
    expect(await currentKimiCredential(freshPort as never, { now: () => 100_000 })).toEqual({
      ...current,
      expiresAt: 400_001,
    });

    const refreshed = { ...current, accessToken: "new-access", expiresAt: 500_000 };
    const port = {
      read: async () => ({ value: current, revision: 7 }),
      refresh: async (revision: number, exchange: RefreshExchange) => {
        expect(revision).toBe(7);
        const result = await exchange({ value: current, revision }, new AbortController().signal);
        expect(result.metadata).toEqual({ expiresAt: 500_000 });
        return { status: "updated", snapshot: { value: result.value, revision: 8 } };
      },
    };
    expect(
      await currentKimiCredential(port as never, {
        now: () => 100_000,
        fetch: sequence([Response.json({ access_token: "new-access", expires_in: 400 })]),
      }),
    ).toEqual(refreshed);
  });
});
