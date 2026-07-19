import { expect, test } from "bun:test";
import { parseXAIGrokBilling, validateXAIGrokGrpcStatus } from "./quota-protobuf";

test("parses framed and unframed Grok billing payloads", () => {
  const payload = billingPayload(42.5, 1_800_000_000);
  const now = 1_799_000_000_000;
  expect(parseXAIGrokBilling(frame(payload), now)).toEqual({
    usedPercent: 42.5,
    resetsAt: 1_800_000_000_000,
  });
  expect(parseXAIGrokBilling(payload, now)).toEqual({
    usedPercent: 42.5,
    resetsAt: 1_800_000_000_000,
  });
});

test("parses CodexBar's observed omitted zero-percent billing period", () => {
  const payload = Buffer.from(
    "0a280d0000000012001a002206088097f3d0062a060880b191d206421208011206088097f3d0061a060880b191d206",
    "hex",
  );
  expect(parseXAIGrokBilling(payload, 1_781_000_000_000)).toEqual({
    usedPercent: 0,
    resetsAt: 1_782_864_000_000,
  });
  expect(() => parseXAIGrokBilling(Uint8Array.from([0x10, ...varint(1_800_000_000)]), 0)).toThrow(
    "Could not parse xAI Grok billing usage",
  );
});

test("prefers billing field one over an earlier unrelated float", () => {
  const payload = new Uint8Array(10);
  payload[0] = 0x4d;
  new DataView(payload.buffer).setFloat32(1, 7, true);
  payload[5] = 0x0d;
  new DataView(payload.buffer).setFloat32(6, 42, true);
  expect(parseXAIGrokBilling(payload, 0).usedPercent).toBe(42);
});

test("rejects nonzero grpc status from headers or trailer frames", () => {
  expect(() => validateXAIGrokGrpcStatus(new Headers({ "grpc-status": "16" }))).toThrow("RPC failed");
  const trailer = frame(new TextEncoder().encode("grpc-status: 7\r\n"), 0x80);
  expect(() => parseXAIGrokBilling(trailer, 0)).toThrow("RPC failed");
});

function billingPayload(usedPercent: number, resetEpoch: number): Uint8Array {
  const encodedReset = varint(resetEpoch);
  const bytes = new Uint8Array(6 + encodedReset.length);
  bytes[0] = 0x0d;
  new DataView(bytes.buffer).setFloat32(1, usedPercent, true);
  bytes[5] = 0x10;
  bytes.set(encodedReset, 6);
  return bytes;
}

function frame(payload: Uint8Array, flags = 0): Uint8Array {
  const bytes = new Uint8Array(payload.length + 5);
  bytes[0] = flags;
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
