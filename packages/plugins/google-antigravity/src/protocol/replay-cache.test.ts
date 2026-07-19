import { expect, test } from "bun:test";

import { type ReasoningReplay, ReasoningReplayCache } from "./replay-cache";

const HOUR = 3_600_000;

test("older generations cannot overwrite or clear newer replay", () => {
  const cache = new ReasoningReplayCache({ now: fakeClock().now, ttlMs: HOUR, maxEntries: 10_240 });
  const older = cache.begin("claude-opus-4-6-thinking", "sha256:session", "request-old");
  const newer = cache.begin("claude-opus-4-6-thinking", "sha256:session", "request-new");

  expect(cache.commit(newer, replay("new"))).toBe(true);
  expect(cache.commit(older, replay("old"))).toBe(false);
  expect(cache.clear(older)).toBe(false);
  expect(cache.read(newer.key)?.parts).toEqual(replay("new").parts);
});

test("reads slide the one-hour expiry", () => {
  const clock = fakeClock();
  const cache = new ReasoningReplayCache({ now: clock.now, ttlMs: HOUR, maxEntries: 10_240 });
  const scope = cache.begin("model", "sha256:session", "request");
  cache.commit(scope, replay("live"));

  clock.advance(HOUR - 1);
  expect(cache.read(scope.key)?.parts).toEqual(replay("live").parts);
  clock.advance(HOUR - 1);
  expect(cache.read(scope.key)?.parts).toEqual(replay("live").parts);
  clock.advance(HOUR + 1);
  expect(cache.read(scope.key)).toBeUndefined();
});

test("expires an untouched entry at exactly one hour", () => {
  const clock = fakeClock();
  const cache = new ReasoningReplayCache({ now: clock.now, ttlMs: HOUR, maxEntries: 10_240 });
  const scope = cache.begin("model", "sha256:session", "request");
  cache.commit(scope, replay("expired"));

  clock.advance(HOUR);

  expect(cache.read(scope.key)).toBeUndefined();
});

test("evicts the oldest-access entry after 10,240 keys", () => {
  const clock = fakeClock();
  const cache = new ReasoningReplayCache({ now: clock.now, ttlMs: HOUR, maxEntries: 10_240 });
  const scopes = Array.from({ length: 10_240 }, (_, index) => {
    clock.advance(1);
    const scope = cache.begin(`model-${index}`, "sha256:session", `request-${index}`);
    cache.commit(scope, replay(String(index)));
    return scope;
  });
  const first = requiredScope(scopes, 0);
  const second = requiredScope(scopes, 1);
  clock.advance(1);
  expect(cache.read(first.key)).toBeDefined();
  clock.advance(1);
  cache.begin("overflow", "sha256:session", "request-overflow");

  expect(cache.read(first.key)).toBeDefined();
  expect(cache.read(second.key)).toBeUndefined();
});

test("an evicted generation cannot overwrite a recreated replay key", () => {
  const clock = fakeClock();
  const cache = new ReasoningReplayCache({ now: clock.now, ttlMs: HOUR, maxEntries: 1 });
  const evicted = cache.begin("model", "sha256:session", "same-request");
  clock.advance(1);
  cache.begin("other-model", "sha256:session", "other-request");
  clock.advance(1);
  const current = cache.begin("model", "sha256:session", "same-request");

  expect(current.generation).toBeGreaterThan(evicted.generation);
  expect(cache.commit(current, replay("current"))).toBe(true);
  expect(cache.commit(evicted, replay("stale"))).toBe(false);
  expect(cache.read(current.key)?.parts).toEqual(replay("current").parts);
});

test("shares a generation for the same logical request across Provider attempts", () => {
  const cache = new ReasoningReplayCache({ now: fakeClock().now, ttlMs: HOUR, maxEntries: 10_240 });
  const firstProvider = cache.begin("model", "sha256:session", "logical-request");
  const fallbackProvider = cache.begin("model", "sha256:session", "logical-request");
  const concurrent = cache.begin("model", "sha256:session", "other-request");

  expect(fallbackProvider).toEqual(firstProvider);
  expect(concurrent.key).toBe(firstProvider.key);
  expect(concurrent.generation).toBeGreaterThan(firstProvider.generation);
});

test("logical-request generation reuse has an independent sliding one-hour expiry", () => {
  const clock = fakeClock();
  const cache = new ReasoningReplayCache({ now: clock.now, ttlMs: HOUR, maxEntries: 10_240 });
  const first = cache.begin("model", "sha256:session", "logical-request");
  cache.commit(first, replay("live"));

  clock.advance(HOUR - 1);
  const retry = cache.begin("model", "sha256:session", "logical-request");
  expect(retry.generation).toBe(first.generation);

  clock.advance(HOUR - 1);
  expect(cache.read(first.key)).toBeDefined();
  clock.advance(2);
  const afterMappingExpiry = cache.begin("model", "sha256:session", "logical-request");

  expect(afterMappingExpiry.generation).toBeGreaterThan(first.generation);
  expect(cache.read(first.key)).toBeDefined();
});

test("expires a logical-request mapping at its exact boundary", () => {
  const clock = fakeClock();
  const cache = new ReasoningReplayCache({ now: clock.now, requestTtlMs: HOUR, ttlMs: HOUR * 2 });
  const first = cache.begin("model", "sha256:session", "logical-request");

  clock.advance(HOUR);
  const afterMappingExpiry = cache.begin("model", "sha256:session", "logical-request");

  expect(afterMappingExpiry.generation).toBeGreaterThan(first.generation);
});

test("bounds logical-request generation mappings by oldest access across an active replay key", () => {
  const clock = fakeClock();
  const cache = new ReasoningReplayCache({ now: clock.now, ttlMs: HOUR, maxEntries: 10_240 });
  const scopes = Array.from({ length: 10_240 }, (_, index) => {
    clock.advance(1);
    return cache.begin("model", "sha256:active-session", `request-${index}`);
  });
  const first = requiredScope(scopes, 0);
  const second = requiredScope(scopes, 1);
  clock.advance(1);
  expect(cache.begin("model", "sha256:active-session", "request-0").generation).toBe(first.generation);
  clock.advance(1);
  cache.begin("model", "sha256:active-session", "overflow-request");

  expect(cache.begin("model", "sha256:active-session", "request-0").generation).toBe(first.generation);
  expect(cache.begin("model", "sha256:active-session", "request-1").generation).toBeGreaterThan(second.generation);
});

test("keys vary only by wire model and normalized session", () => {
  const cache = new ReasoningReplayCache({ now: fakeClock().now, ttlMs: HOUR, maxEntries: 10_240 });
  const first = cache.begin("model-a", "sha256:session", "request");
  const same = cache.begin("model-a", "sha256:session", "request");
  const otherModel = cache.begin("model-b", "sha256:session", "request");

  expect(first.key).toBe("model-a\u0000sha256:session");
  expect(same.key).toBe(first.key);
  expect(otherModel.key).not.toBe(first.key);
});

test("bulk entry expiry does not repeatedly scan the full request mapping table", () => {
  const clock = fakeClock();
  const entryCount = 10_240;
  const cache = new ReasoningReplayCache({
    maxEntries: entryCount,
    maxRequestMappings: entryCount,
    now: clock.now,
    requestTtlMs: HOUR,
    ttlMs: HOUR,
  });
  for (let index = 0; index < entryCount; index += 1) {
    cache.begin(`model-${index}`, "sha256:bulk-expiry", `request-${index}`);
  }
  clock.advance(HOUR);

  const originalIterator = Map.prototype[Symbol.iterator] as unknown as (
    this: Map<unknown, unknown>,
  ) => IterableIterator<[unknown, unknown]>;
  let requestMappingVisits = 0;
  Reflect.set(Map.prototype, Symbol.iterator, function (this: Map<unknown, unknown>) {
    const iterator = originalIterator.call(this);
    return {
      next() {
        const result = iterator.next();
        if (!result.done && isRequestGenerationEntry(result.value[1])) requestMappingVisits += 1;
        return result;
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  });
  try {
    cache.begin("fresh-model", "sha256:bulk-expiry", "fresh-request");
  } finally {
    Reflect.set(Map.prototype, Symbol.iterator, originalIterator);
  }

  expect(requestMappingVisits).toBeLessThanOrEqual(entryCount);
});

function replay(marker: string): ReasoningReplay {
  return {
    parts: [
      {
        type: "function-call",
        contentIndex: 0,
        partIndex: 0,
        call: { name: marker, args: {} },
        signature: marker.repeat(50),
      },
    ],
  };
}

function fakeClock() {
  let value = 0;
  return { now: () => value, advance: (milliseconds: number) => (value += milliseconds) };
}

function requiredScope(scopes: readonly ReturnType<ReasoningReplayCache["begin"]>[], index: number) {
  const scope = scopes[index];
  if (scope === undefined) throw new Error("missing replay scope fixture");
  return scope;
}

function isRequestGenerationEntry(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "replayKey");
}
