import { afterEach, expect, test } from "bun:test";

import {
  OAuthQuotaReadError,
  OAuthQuotaResetError,
  OAuthQuotaResetUnavailableError,
  OAuthQuotaResetUnsupportedError,
} from "./errors";
import { createOAuthQuotaOperations } from "./index";
import { createOAuthQuotaResetter } from "./reset";
import {
  availableQuotaSnapshot,
  CAPABILITY,
  capturedQuotaError,
  cleanupQuotaFixtures,
  createQuotaFixture,
  PLUGIN,
  PROVIDER_ID,
  quotaSignal,
} from "./test-support";

afterEach(cleanupQuotaFixtures);

test("rejects an adapter without quota.reset before any preflight read", async () => {
  const fixture = createQuotaFixture({ read: async () => availableQuotaSnapshot });

  const error = await capturedQuotaError(
    createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()),
  );

  expect(error).toBeInstanceOf(OAuthQuotaResetUnsupportedError);
  expect(error).toMatchObject({ code: "OAUTH_QUOTA_RESET_UNSUPPORTED" });
  expect(fixture.readCalls()).toBe(0);
  expect(fixture.resetCalls()).toBe(0);
});

test.each([
  ["missing reset credits", { items: [] }],
  ["zero reset credits", { items: [], resetCredits: { availableCount: 0 } }],
] as const)("rejects %s without mutation", async (_name, snapshot) => {
  const fixture = createQuotaFixture({ read: async () => snapshot, reset: async () => {} });

  const error = await capturedQuotaError(
    createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()),
  );

  expect(error).toBeInstanceOf(OAuthQuotaResetUnavailableError);
  expect(error).toMatchObject({ code: "OAUTH_QUOTA_RESET_UNAVAILABLE" });
  expect(fixture.readCalls()).toBe(1);
  expect(fixture.resetCalls()).toBe(0);
});

test.each([
  ["rejected", async () => Promise.reject(new Error("preflight failed"))],
  ["invalid", async () => ({ items: [{ id: "bad", label: "Bad", remainingRatio: 2 }] }) as never],
] as const)("maps a %s preflight to a read failure without mutation", async (_name, read) => {
  const fixture = createQuotaFixture({ read, reset: async () => {} });

  const error = await capturedQuotaError(
    createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()),
  );

  expect(error).toBeInstanceOf(OAuthQuotaReadError);
  expect(fixture.resetCalls()).toBe(0);
  expect(fixture.logs).toHaveLength(1);
  expect(fixture.logs[0]).toMatchObject({
    event: "plugin.quota.reset.preflight.failed",
    code: "QUOTA_READ_FAILED",
    context: { plugin: PLUGIN, capability: CAPABILITY, providerId: PROVIDER_ID },
  });
});

test("performs one direct preflight read and one mutation in the same context without a post-read", async () => {
  const trace: string[] = [];
  const fixture = createQuotaFixture({
    read: async () => {
      trace.push("read");
      return availableQuotaSnapshot;
    },
    reset: async () => {
      trace.push("reset");
    },
  });
  const requestSignal = quotaSignal();

  await createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, requestSignal);

  expect(trace).toEqual(["read", "reset"]);
  expect(fixture.readCalls()).toBe(1);
  expect(fixture.resetCalls()).toBe(1);
  expect(fixture.contexts[0]).toBe(fixture.resetContexts[0]);
  expect(fixture.resetContexts[0]?.signal).toBe(requestSignal);
});

test("checks abortion after preflight and before mutation", async () => {
  const controller = new AbortController();
  const fixture = createQuotaFixture({
    read: async () => {
      controller.abort();
      return availableQuotaSnapshot;
    },
    reset: async () => {},
  });

  const error = await capturedQuotaError(
    createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, controller.signal),
  );

  expect(error.name).toBe("AbortError");
  expect(fixture.readCalls()).toBe(1);
  expect(fixture.resetCalls()).toBe(0);
  expect(fixture.logs).toHaveLength(0);
});

test("logs one mutation failure, does not retry, and throws a stable reset error", async () => {
  const fixture = createQuotaFixture({
    read: async () => availableQuotaSnapshot,
    reset: async () => {
      throw new Error("mutation failed");
    },
  });

  const error = await capturedQuotaError(
    createOAuthQuotaResetter(fixture.dependencies).reset(PROVIDER_ID, quotaSignal()),
  );

  expect(error).toBeInstanceOf(OAuthQuotaResetError);
  expect(error).toMatchObject({
    name: "OAuthQuotaResetError",
    message: "OAuth quota reset failed",
    code: "OAUTH_QUOTA_RESET_FAILED",
  });
  expect(error).not.toHaveProperty("cause");
  expect(fixture.readCalls()).toBe(1);
  expect(fixture.resetCalls()).toBe(1);
  expect(fixture.logs).toHaveLength(1);
  expect(fixture.logs[0]).toMatchObject({
    event: "plugin.quota.reset.failed",
    code: "QUOTA_RESET_FAILED",
    context: { plugin: PLUGIN, capability: CAPABILITY, providerId: PROVIDER_ID },
  });
});

test("finishes reset without a post-read and reports a later independent read failure only from read", async () => {
  const fixture = createQuotaFixture({
    read: async () => {
      if (fixture.readCalls() === 1) return availableQuotaSnapshot;
      throw new Error("later read failed");
    },
    reset: async () => {},
  });
  const operations = createOAuthQuotaOperations(fixture.dependencies);

  await operations.reset(PROVIDER_ID, quotaSignal());
  expect(fixture.readCalls()).toBe(1);
  expect(fixture.logs).toHaveLength(0);

  const error = await capturedQuotaError(operations.read(PROVIDER_ID, quotaSignal()));
  expect(error).toBeInstanceOf(OAuthQuotaReadError);
  expect(fixture.logs).toHaveLength(1);
  expect(fixture.logs[0]?.event).toBe("plugin.quota.read.failed");
});
