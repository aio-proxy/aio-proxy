import { expect, test } from "bun:test";
import type { CredentialPort } from "@aio-proxy/plugin-sdk";
import type { GoogleAntigravityCredential } from "../schema";
import { createAntigravityCredentialSource } from "./credential";

test("adapts current and forced credential reads through the host credential port", async () => {
  let snapshot = { value: credentialFixture({ expiresAt: 1_700_000_001_000 }), revision: 1 };
  const port: CredentialPort<GoogleAntigravityCredential> = {
    read: async () => snapshot,
    refresh: async (_revision, exchange) => {
      const next = await exchange(snapshot, new AbortController().signal);
      snapshot = { value: next.value, revision: 2 };
      return { status: "updated", snapshot };
    },
  };
  const source = createAntigravityCredentialSource(port, {
    fetch: async () => Response.json({ access_token: "access-2", expires_in: 3_600 }),
    now: () => 1_700_000_000_000,
  });

  expect((await source.current()).accessToken).toBe("access-2");
  expect((await source.forceRefresh()).accessToken).toBe("access-2");
});

test("one cancelled credential waiter does not cancel the shared refresh for another waiter", async () => {
  let current = { value: credentialFixture({ expiresAt: 1 }), revision: 1 };
  let flight: ReturnType<CredentialPort<GoogleAntigravityCredential>["refresh"]> | undefined;
  let exchanges = 0;
  let releaseFetch = () => {};
  let markFetchStarted = () => {};
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve;
  });
  const port: CredentialPort<GoogleAntigravityCredential> = {
    read: async () => current,
    refresh: (_revision, exchange) => {
      flight ??= (async () => {
        exchanges += 1;
        const exchanged = await exchange(current, new AbortController().signal);
        current = { value: exchanged.value, revision: 2 };
        return { status: "updated", snapshot: current };
      })();
      return flight;
    },
  };
  const source = createAntigravityCredentialSource(port, {
    fetch: async () => {
      markFetchStarted();
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return Response.json({ access_token: "access-2", expires_in: 3_600 });
    },
  });
  const controller = new AbortController();
  const reason = { kind: "caller-stopped" };
  const cancelled = source.forceRefresh(controller.signal);
  await fetchStarted;
  const waiting = source.forceRefresh();
  controller.abort(reason);

  const outcome = await Promise.race([
    cancelled.then(
      () => "resolved",
      (error: unknown) => error,
    ),
    Bun.sleep(25).then(() => "timeout"),
  ]);
  releaseFetch();
  await cancelled.catch(() => undefined);
  await expect(waiting).resolves.toMatchObject({ accessToken: "access-2" });
  expect(outcome).toBe(reason);
  expect(exchanges).toBe(1);
});

function credentialFixture(overrides: Partial<GoogleAntigravityCredential> = {}): GoogleAntigravityCredential {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1_900_000_000_000,
    email: "person@example.com",
    projectId: "project-1",
    ...overrides,
  };
}
