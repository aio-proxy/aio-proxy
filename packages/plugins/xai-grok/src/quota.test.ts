import { expect, test } from "bun:test";
import type { CredentialPort } from "@aio-proxy/plugin-sdk";
import { readXAIGrokQuota } from "./quota";
import type { XAIGrokCredential } from "./schema";

test("reads weekly and monthly Grok billing through the CLI proxy", async () => {
  const requests: Request[] = [];
  const snapshot = await readXAIGrokQuota(context(), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith("?format=credits")) {
        return Response.json({
          config: {
            currentPeriod: { type: "weekly", end: "2027-01-15T00:00:00Z" },
            creditUsagePercent: "25",
          },
        });
      }
      return Response.json({
        config: {
          monthlyLimit: { val: "10000" },
          used: { val: 2500 },
          billingPeriodEnd: "2027-02-01T00:00:00Z",
        },
      });
    },
  });

  expect(requests.map(({ url }) => url)).toEqual([
    "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
    "https://cli-chat-proxy.grok.com/v1/billing",
  ]);
  for (const request of requests) {
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer access-token");
    expect(request.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(request.headers.get("x-grok-client-version")).toBe("0.2.93");
    expect(request.headers.get("user-agent")).toBe("xai-grok-workspace/0.2.93");
    expect(request.headers.get("x-userid")).toBe("user-123");
  }
  expect(snapshot).toEqual({
    items: [
      {
        id: "weekly",
        label: { default: "Weekly limit", "zh-Hans": "周额度" },
        remainingRatio: 0.75,
        resetsAt: Date.parse("2027-01-15T00:00:00Z"),
      },
      {
        id: "monthly-credits",
        label: { default: "Monthly credits", "zh-Hans": "月度额度" },
        remainingRatio: 0.75,
        resetsAt: Date.parse("2027-02-01T00:00:00Z"),
      },
    ],
  });
});

test("keeps valid monthly quota when weekly billing fails", async () => {
  const snapshot = await readXAIGrokQuota(context(), {
    fetch: async (input) => {
      if (new URL(input.toString()).searchParams.has("format")) return new Response(null, { status: 503 });
      return Response.json({
        config: {
          monthly_limit: { val: 100 },
          used: { val: 140 },
          billing_period_end: "2027-02-01T00:00:00Z",
        },
      });
    },
  });

  expect(snapshot.items).toEqual([
    {
      id: "monthly-credits",
      label: { default: "Monthly credits", "zh-Hans": "月度额度" },
      remainingRatio: 0,
      resetsAt: Date.parse("2027-02-01T00:00:00Z"),
    },
  ]);
});

test("fails quota read when neither billing endpoint returns quota", async () => {
  await expect(readXAIGrokQuota(context(), { fetch: async () => new Response(null, { status: 503 }) })).rejects.toThrow(
    "xAI Grok billing request failed",
  );
});

function context() {
  return { credentials: port(), options: {}, signal: new AbortController().signal };
}

function port(): CredentialPort<XAIGrokCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: {
        accessToken: "access-token",
        refreshToken: "refresh",
        expiresAt: 1_900_000_000_000,
        subject: "user-123",
      },
    }),
    refresh: async () => {
      throw new Error("fresh credential must not refresh");
    },
  };
}
