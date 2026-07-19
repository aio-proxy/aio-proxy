import { expect, test } from "bun:test";
import type { CredentialPort } from "@aio-proxy/plugin-sdk";
import { readXAIGrokQuota } from "./quota";
import type { XAIGrokCredential } from "./schema";

test("reads Grok credits with OAuth and maps used percent to remaining ratio", async () => {
  let request: Request | undefined;
  const snapshot = await readXAIGrokQuota(
    { credentials: port(), options: {}, signal: new AbortController().signal },
    {
      now: () => 1_799_000_000_000,
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(frame(billingPayload(25, 1_800_000_000)), {
          status: 200,
          headers: { "content-type": "application/grpc-web+proto", "grpc-status": "0" },
        });
      },
    },
  );

  expect(request?.url).toBe("https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig");
  expect(request?.method).toBe("POST");
  expect(request?.headers.get("authorization")).toBe("Bearer access-token");
  expect(request?.headers.get("origin")).toBe("https://grok.com");
  expect(request?.headers.get("referer")).toBe("https://grok.com/?_s=usage");
  expect(request?.headers.get("content-type")).toBe("application/grpc-web+proto");
  expect(request?.headers.get("x-grpc-web")).toBe("1");
  expect(request?.headers.get("x-user-agent")).toBe("connect-es/2.1.1");
  if (request === undefined) throw new Error("quota request was not captured");
  expect(new Uint8Array(await request.arrayBuffer())).toEqual(Uint8Array.of(0, 0, 0, 0, 0));
  expect(snapshot).toEqual({
    items: [
      {
        id: "credits",
        label: { default: "Credits", "zh-Hans": "额度" },
        remainingRatio: 0.75,
        resetsAt: 1_800_000_000_000,
      },
    ],
  });
  expect(snapshot.resetCredits).toBeUndefined();
});

function port(): CredentialPort<XAIGrokCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: { accessToken: "access-token", refreshToken: "refresh", expiresAt: 1_900_000_000_000 },
    }),
    refresh: async () => {
      throw new Error("fresh credential must not refresh");
    },
  };
}

function billingPayload(usedPercent: number, resetEpoch: number): Uint8Array {
  const encodedReset = varint(resetEpoch);
  const bytes = new Uint8Array(6 + encodedReset.length);
  bytes[0] = 0x0d;
  new DataView(bytes.buffer).setFloat32(1, usedPercent, true);
  bytes[5] = 0x10;
  bytes.set(encodedReset, 6);
  return bytes;
}

function frame(payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(payload.length + 5);
  new DataView(bytes.buffer).setUint32(1, payload.length);
  bytes.set(payload, 5);
  return bytes;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let current = BigInt(value);
  while (current >= 0x80n) {
    bytes.push(Number(current & 0x7fn) | 0x80);
    current >>= 7n;
  }
  bytes.push(Number(current));
  return bytes;
}
