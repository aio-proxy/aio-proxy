import { expect, test } from "bun:test";
import { createHubVersionCache } from "./hub-version";

test("returns the verified fallback immediately and refreshes in the background", async () => {
  let resolveFetch = (_response: Response) => {};
  const response = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const cache = createHubVersionCache({ fetch: async () => await response, platform: "darwin", arch: "arm64" });

  expect(cache.version()).toBe("2.2.1");
  resolveFetch(new Response("version: 3.4.5\nfiles: []"));
  await settle();
  expect(cache.version()).toBe("3.4.5");
  expect(cache.shortUserAgent()).toBe("antigravity/hub/3.4.5 darwin/arm64");
  expect(cache.onboardingUserAgent()).toBe("antigravity/hub/3.4.5 darwin/arm64 google-api-nodejs-client/10.3.0");
});

test("keeps a verified cached version for six hours", async () => {
  let now = 1_000;
  let fetches = 0;
  const cache = createHubVersionCache({
    fetch: async () => {
      fetches += 1;
      return new Response("version: 3.4.5");
    },
    now: () => now,
  });

  cache.version();
  await settle();
  expect(cache.version()).toBe("3.4.5");
  now += 6 * 60 * 60_000 - 1;
  expect(cache.version()).toBe("3.4.5");
  expect(fetches).toBe(1);
});

test("ignores invalid manifests and retains the last verified version", async () => {
  let manifest = "version: 3.4.5";
  let now = 0;
  const cache = createHubVersionCache({ fetch: async () => new Response(manifest), now: () => now });
  cache.version();
  await settle();
  expect(cache.version()).toBe("3.4.5");

  now += 6 * 60 * 60_000;
  manifest = "version: v-secret-build";
  expect(cache.version()).toBe("3.4.5");
  await settle();
  expect(cache.version()).toBe("3.4.5");
});

test("an aborted manifest refresh does not delay the fallback caller", async () => {
  const aborted = AbortSignal.abort();
  let observedSignal: AbortSignal | undefined;
  const cache = createHubVersionCache({
    fetch: async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      throw new DOMException("Timed out", "AbortError");
    },
    timeoutSignal: () => aborted,
  });

  expect(cache.version()).toBe("2.2.1");
  await settle();
  expect(observedSignal?.aborted).toBe(true);
  expect(cache.version()).toBe("2.2.1");
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Bun.sleep(0);
}
