import type { AccountContext } from "@aio-proxy/plugin-sdk";

import { discoverAntigravityCatalog, type GoogleAntigravityCredential } from "@aio-proxy/plugin-google-antigravity";
import { expect, test } from "bun:test";

import { CatalogScheduler } from "./catalog-scheduler";

test("scheduler leaves enough host budget for daily timeout and prod discovery", async () => {
  let written: unknown;
  let resolveWrite = () => {};
  const catalogWritten = new Promise<void>((resolve) => {
    resolveWrite = resolve;
  });
  const scheduler = new CatalogScheduler({
    repository: {
      writeCatalog(_providerId: string, catalog: unknown) {
        written = catalog;
        resolveWrite();
      },
      writeDiagnostic() {
        return true;
      },
      clearDiagnostic() {
        return true;
      },
    } as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    rebuild: async () => {},
    discoveryTimeoutMs: 50,
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "static" },
      stored: null,
      discover: async (signal) =>
        await discoverAntigravityCatalog(discoveryContext(signal), {
          fetch: async (input, init) => {
            if (new URL(String(input)).origin === "https://cloudcode-pa.googleapis.com") {
              return Response.json({ models: { prod: {} } });
            }
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
            });
          },
          timeoutSignal: () => AbortSignal.timeout(5),
        }),
    },
  ]);

  await Promise.race([catalogWritten, Bun.sleep(100).then(() => Promise.reject(new Error("catalog write timed out")))]);
  expect(written).toMatchObject({ language: [{ id: "prod" }] });
  scheduler.close();
});

function discoveryContext(signal: AbortSignal): AccountContext<GoogleAntigravityCredential, Record<string, never>> {
  const value: GoogleAntigravityCredential = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Number.MAX_SAFE_INTEGER,
    email: "person@example.com",
    projectId: "project-1",
  };
  return {
    options: {},
    signal,
    credentials: {
      read: async () => ({ value, revision: 1 }),
      refresh: async () => ({ status: "superseded", snapshot: { value, revision: 1 } }),
    },
  };
}
