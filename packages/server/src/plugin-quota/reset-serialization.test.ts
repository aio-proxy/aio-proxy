import { afterEach, expect, test } from "bun:test";

import { OAuthQuotaReadError, OAuthQuotaResetError } from "./errors";
import { createOAuthQuotaOperations } from "./index";
import { createOAuthQuotaResetter } from "./reset";
import {
  availableQuotaSnapshot,
  cleanupQuotaFixtures,
  createQuotaFixture,
  PROVIDER_ID,
  quotaSignal,
} from "./test-support";

afterEach(cleanupQuotaFixtures);

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

test("serializes same-Provider-ID resets as read-reset-read-reset", async () => {
  const firstRead = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const trace: string[] = [];
  const fixture = createQuotaFixture({
    read: async () => {
      trace.push("read");
      if (fixture.readCalls() === 1) {
        firstRead.resolve();
        await releaseFirst.promise;
      }
      return availableQuotaSnapshot;
    },
    reset: async () => {
      trace.push("reset");
    },
  });
  const resetter = createOAuthQuotaResetter(fixture.dependencies);

  const first = resetter.reset(PROVIDER_ID, quotaSignal());
  await firstRead.promise;
  const second = resetter.reset(PROVIDER_ID, quotaSignal());
  await settle();
  expect(trace).toEqual(["read"]);

  releaseFirst.resolve();
  await Promise.all([first, second]);
  expect(trace).toEqual(["read", "reset", "read", "reset"]);
});

test("a failed reset does not poison the next same-ID queue entry", async () => {
  const trace: string[] = [];
  const fixture = createQuotaFixture({
    read: async () => {
      trace.push("read");
      return availableQuotaSnapshot;
    },
    reset: async () => {
      trace.push("reset");
      if (fixture.resetCalls() === 1) throw new Error("first failed");
    },
  });
  const resetter = createOAuthQuotaResetter(fixture.dependencies);

  const first = resetter.reset(PROVIDER_ID, quotaSignal());
  const second = resetter.reset(PROVIDER_ID, quotaSignal());

  await expect(first).rejects.toBeInstanceOf(OAuthQuotaResetError);
  await expect(second).resolves.toBeUndefined();
  expect(trace).toEqual(["read", "reset", "read", "reset"]);
});

test("lets resets for different Provider IDs enter preflight concurrently", async () => {
  const otherProviderId = "organization";
  const bothStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const started = new Set<string>();
  const fixture = createQuotaFixture({
    additionalProviderIds: [otherProviderId],
    read: async ({ options }) => {
      started.add((options as { region: string }).region);
      if (started.size === 2) bothStarted.resolve();
      await release.promise;
      return availableQuotaSnapshot;
    },
    reset: async () => {},
  });
  const resetter = createOAuthQuotaResetter(fixture.dependencies);

  const pending = Promise.all([
    resetter.reset(PROVIDER_ID, quotaSignal()),
    resetter.reset(otherProviderId, quotaSignal()),
  ]);
  await bothStarted.promise;
  expect(started).toEqual(new Set(["us-east", "organization-region"]));

  release.resolve();
  await pending;
});

test("a normal concurrent read never satisfies reset preflight", async () => {
  const normalStarted = Promise.withResolvers<void>();
  const releaseNormal = Promise.withResolvers<void>();
  const fixture = createQuotaFixture({
    read: async () => {
      if (fixture.readCalls() === 1) {
        normalStarted.resolve();
        await releaseNormal.promise;
      }
      return availableQuotaSnapshot;
    },
    reset: async () => {},
  });
  const operations = createOAuthQuotaOperations(fixture.dependencies);

  const normal = operations.read(PROVIDER_ID, quotaSignal());
  await normalStarted.promise;
  const reset = operations.reset(PROVIDER_ID, quotaSignal());
  await settle();
  expect(fixture.readCalls()).toBe(2);
  expect(fixture.resetCalls()).toBe(1);

  releaseNormal.resolve();
  await Promise.all([normal, reset]);
});

test("acquires each queued lease only when its turn starts and never mixes snapshots", async () => {
  const oldRead = Promise.withResolvers<void>();
  const releaseOld = Promise.withResolvers<void>();
  const trace: string[] = [];
  const old = createQuotaFixture({
    read: async () => {
      trace.push("old-read");
      oldRead.resolve();
      await releaseOld.promise;
      return availableQuotaSnapshot;
    },
    reset: async () => {
      trace.push("old-reset");
    },
  });
  const next = createQuotaFixture({
    read: async () => {
      trace.push("new-read");
      return availableQuotaSnapshot;
    },
    reset: async () => {
      trace.push("new-reset");
    },
  });
  const resetter = createOAuthQuotaResetter(old.dependencies);

  const first = resetter.reset(PROVIDER_ID, quotaSignal());
  await oldRead.promise;
  const second = resetter.reset(PROVIDER_ID, quotaSignal());
  const retired = old.manager.swap(next.snapshot);
  releaseOld.resolve();

  await Promise.all([first, second]);
  await retired.whenDrained;
  expect(trace).toEqual(["old-read", "old-reset", "new-read", "new-reset"]);
});

test("keeps a reset preflight independent from a concurrent failed read", async () => {
  const fixture = createQuotaFixture({
    read: async () => {
      if (fixture.readCalls() === 1) throw new Error("normal read failed");
      return availableQuotaSnapshot;
    },
    reset: async () => {},
  });
  const operations = createOAuthQuotaOperations(fixture.dependencies);

  await expect(operations.read(PROVIDER_ID, quotaSignal())).rejects.toBeInstanceOf(OAuthQuotaReadError);
  await expect(operations.reset(PROVIDER_ID, quotaSignal())).resolves.toBeUndefined();
  expect(fixture.readCalls()).toBe(2);
  expect(fixture.resetCalls()).toBe(1);
});
