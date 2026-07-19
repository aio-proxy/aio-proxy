import { expect, test } from "bun:test";
import { type AccountContext, type CredentialPort, CredentialRefreshError } from "@aio-proxy/plugin-sdk";
import { discoverKimiCatalog } from "./catalog";
import { currentKimiCredential, type KimiCredential, type KimiOAuthDependencies, refreshKimiCredential } from "./oauth";
import { readKimiQuota } from "./quota";
import { createKimiDynamicFetch } from "./runtime";

const credential: KimiCredential = {
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: 0,
  deviceId: "device-1",
};

const fetchResponse = (response: Response): typeof fetch => (async () => response) as typeof fetch;

test("treats invalid_grant as terminal even on a retryable HTTP status", async () => {
  const error = await refreshKimiCredential(credential, {
    fetch: fetchResponse(Response.json({ error: "invalid_grant" }, { status: 503 })),
  }).catch((caught) => caught);

  expect(error).toBeInstanceOf(CredentialRefreshError);
  expect(error).toMatchObject({ retryable: false, options: { reason: "invalid_grant", status: 503 } });
});

test("keeps successful-response body transport failures retryable", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("response interrupted"));
      },
    }),
  );
  const error = await refreshKimiCredential(credential, { fetch: fetchResponse(response) }).catch((caught) => caught);

  expect(error).toBeInstanceOf(CredentialRefreshError);
  expect(error).toMatchObject({ retryable: true, options: { reason: "network" } });
  expect(String(error)).not.toContain("response interrupted");
});

test("caller cancellation stops waiting for a shared credential refresh", async () => {
  const controller = new AbortController();
  const reason = new Error("caller stopped");
  let started = () => {};
  const refreshStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const port = {
    read: async () => ({ value: credential, revision: 1 }),
    refresh: async () => {
      started();
      return await new Promise<never>(() => {});
    },
  } as CredentialPort<KimiCredential>;

  const pending = currentKimiCredential(port, {
    now: () => 0,
    signal: controller.signal,
  } as KimiOAuthDependencies & { readonly signal: AbortSignal });
  await refreshStarted;
  controller.abort(reason);
  const timeout = Symbol("timeout");
  const outcome = await Promise.race([
    pending.catch((error) => error),
    new Promise<symbol>((resolve) => setTimeout(resolve, 20, timeout)),
  ]);

  expect(outcome).toBe(reason);
});

test.each([
  "catalog",
  "quota",
  "runtime",
] as const)("%s skips credential reads after caller cancellation", async (kind) => {
  const controller = new AbortController();
  const reason = new Error(`${kind} stopped`);
  controller.abort(reason);
  let reads = 0;
  const port = {
    read: async () => {
      reads += 1;
      return { value: { ...credential, expiresAt: 1_000_000 }, revision: 1 };
    },
  } as CredentialPort<KimiCredential>;
  const context = { credentials: port, options: {}, signal: controller.signal } as AccountContext<
    KimiCredential,
    Record<string, never>
  >;
  const neverFetch = (async () => {
    throw new Error("fetch should not run");
  }) as typeof fetch;
  const operation =
    kind === "catalog"
      ? discoverKimiCatalog(context, { fetch: neverFetch })
      : kind === "quota"
        ? readKimiQuota(context, { fetch: neverFetch })
        : createKimiDynamicFetch(port, { fetch: neverFetch })(
            new Request("https://proxy.test/v1/messages", { signal: controller.signal }),
          );

  await expect(operation).rejects.toBe(reason);
  expect(reads).toBe(0);
});
