import type { AccountContext } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { KimiCredential } from "./oauth";

import { readKimiQuota } from "./quota";

const credential: KimiCredential = {
  accessToken: "quota-access-token",
  refreshToken: "quota-refresh-token",
  expiresAt: Number.MAX_SAFE_INTEGER,
  deviceId: "quota-device-id",
};

function context(value: KimiCredential = credential): AccountContext<KimiCredential, Record<string, never>> {
  return {
    credentials: {
      read: async () => ({ value, revision: 1 }),
      refresh: async () => ({ status: "superseded", snapshot: { value: credential, revision: 2 } }),
    },
    options: {},
    signal: new AbortController().signal,
  };
}

test("maps the weekly usage and every valid rolling limit", async () => {
  const account = context({ ...credential, expiresAt: 0 });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(input).toBe("https://api.kimi.com/coding/v1/usages");
    expect(String(input)).not.toContain("www.kimi.com");
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer quota-access-token");
    expect(headers.get("X-Msh-Device-Id")).toBe("quota-device-id");
    expect(init?.signal).toBe(account.signal);
    return Response.json({
      usage: { limit: "100", remaining: 75, resetTime: 1_767_972_193 },
      limits: [
        {
          window: { duration: "300", timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: 100, remaining: "90", resetAt: "2026-01-06T15:33:02.000Z" },
        },
        {
          window: { duration: 60, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "10", remaining: "8", reset_time: "not-a-date" },
        },
        { window: { duration: 30, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: 0, remaining: 0 } },
        { window: { duration: 15, timeUnit: "TIME_UNIT_MINUTE" }, detail: { remaining: 10 } },
      ],
    });
  };

  expect(await readKimiQuota(account, { fetch, now: () => 1_700_000_000_000 })).toEqual({
    items: [
      {
        id: "weekly",
        label: { default: "Weekly quota", "zh-Hans": "周配额" },
        remainingRatio: 0.75,
        resetsAt: 1_767_972_193_000,
      },
      {
        id: "300-time-unit-minute",
        label: { default: "300 minute quota", "zh-Hans": "300 分钟配额" },
        remainingRatio: 0.9,
        resetsAt: 1_767_713_582_000,
      },
      {
        id: "60-time-unit-minute",
        label: { default: "60 minute quota", "zh-Hans": "60 分钟配额" },
        remainingRatio: 0.8,
      },
    ],
  });
});

test("falls back to used, accepts fractional numeric strings, and clamps ratios", async () => {
  const snapshot = await quotaResponse({
    usage: { limit: "2.5", used: "0.625" },
    limits: [
      rolling(1, { limit: "10.5", remaining: "21" }),
      rolling(2, { limit: 10, used: 20 }),
      rolling(3, { limit: 10 }),
    ],
  });

  expect(snapshot.items.map(({ remainingRatio }) => remainingRatio)).toEqual([0.75, 1, 0, undefined]);
});

test("recognizes every reset key and seconds, milliseconds, and ISO timestamps", async () => {
  const snapshot = await quotaResponse({
    usage: { limit: 1, remaining: 1, resetTime: 1_767_972_193 },
    limits: [
      rolling(1, { limit: 1, resetAt: 1_767_713_582_000 }),
      rolling(2, { limit: 1, reset_time: "2026-01-06T15:33:02.000Z" }),
      rolling(3, { limit: 1, reset_at: "2026-01-09T15:23:13.000Z" }),
    ],
  });

  expect(snapshot.items.map(({ resetsAt }) => resetsAt)).toEqual([
    1_767_972_193_000, 1_767_713_582_000, 1_767_713_582_000, 1_767_972_193_000,
  ]);
});

test("drops malformed rows while preserving valid limits", async () => {
  const snapshot = await quotaResponse({
    usage: "invalid",
    limits: [
      null,
      {},
      rolling(1, { limit: 0, remaining: 0 }),
      rolling(2, { limit: "nope", remaining: 1 }),
      rolling(3, { limit: 4, remaining: 1 }),
    ],
  });

  expect(snapshot.items).toEqual([
    {
      id: "3-time-unit-minute",
      label: { default: "3 minute quota", "zh-Hans": "3 分钟配额" },
      remainingRatio: 0.25,
    },
  ]);
});

test("rejects responses without any valid quota windows", async () => {
  await expect(quotaResponse({ usage: { limit: 0 }, limits: [rolling(1, { remaining: 1 })] })).rejects.toThrow(
    "Kimi quota response contains no valid windows",
  );
  await expect(quotaResponse(null)).rejects.toThrow("Kimi quota response is invalid");
});

test("propagates the account abort signal", async () => {
  const account = context();
  let observedSignal: AbortSignal | null | undefined;
  await readKimiQuota(account, {
    fetch: async (_input, init) => {
      observedSignal = init?.signal;
      return Response.json({ usage: { limit: 1, remaining: 1 } });
    },
  });
  expect(observedSignal).toBe(account.signal);
});

test("rejects HTTP failures without exposing credentials or raw bodies", async () => {
  const body = "sensitive quota diagnostic";
  const error = await captureError(async () => new Response(body, { status: 503 }));

  expect(error.message).toBe("Kimi quota request failed with 503");
  const publicSurface = [error.message, ...Object.values(error), JSON.stringify(error)].join("\n");
  expect(publicSurface).not.toContain(credential.accessToken);
  expect(publicSurface).not.toContain(body);
});

function rolling(duration: number, detail: Record<string, unknown>) {
  return { window: { duration, timeUnit: "TIME_UNIT_MINUTE" }, detail };
}

async function quotaResponse(root: unknown) {
  return readKimiQuota(context(), { fetch: async () => Response.json(root) });
}

async function captureError(fetch: typeof globalThis.fetch): Promise<Error> {
  try {
    await readKimiQuota(context(), { fetch });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error("expected quota read to fail");
}
