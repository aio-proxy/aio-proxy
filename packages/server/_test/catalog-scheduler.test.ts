import { expect, test } from "bun:test";
import { CatalogScheduler } from "../src/catalog-scheduler";

const repository = {
  writeCatalog() {},
  writeDiagnostic() {
    return true;
  },
  clearDiagnostic() {
    return true;
  },
};

test("static catalogs with a stored first result do not schedule discovery", async () => {
  let calls = 0;
  const scheduler = new CatalogScheduler({
    repository: repository as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "static" },
      stored: {
        catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
        refreshedAt: 0,
      },
      discover: async () => {
        calls++;
        throw new Error("must not run");
      },
    },
  ]);
  await Bun.sleep(10);
  expect(calls).toBe(0);
  scheduler.close();
});

test("close aborts an in-flight discovery and discards it", async () => {
  let aborted = false;
  const scheduler = new CatalogScheduler({
    repository: repository as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    rebuild: async () => {},
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "static" },
      stored: null,
      discover: (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        ),
    },
  ]);
  await Bun.sleep(10);
  scheduler.close();
  await Bun.sleep(0);
  expect(aborted).toBe(true);
});

test("host deadline settles discovery even when the plugin ignores abort", async () => {
  let diagnostics = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      writeDiagnostic() {
        diagnostics++;
        return true;
      },
    } as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    rebuild: async () => {
      rebuilds++;
    },
    discoveryTimeoutMs: 5,
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "static" },
      stored: null,
      discover: async () => new Promise<never>(() => {}),
    },
  ]);

  await Bun.sleep(30);
  expect(diagnostics).toBe(1);
  expect(rebuilds).toBe(1);
  scheduler.close();
});

test("a catalog that resolves after the host deadline is discarded", async () => {
  let catalogWrites = 0;
  let diagnosticWrites = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      writeCatalog() {
        catalogWrites++;
      },
      writeDiagnostic() {
        diagnosticWrites++;
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
    discoveryTimeoutMs: 5,
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "static" },
      stored: null,
      discover: async () => {
        await Bun.sleep(20);
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
  ]);

  await Bun.sleep(35);
  expect(diagnosticWrites).toBe(1);
  expect(catalogWrites).toBe(0);
  scheduler.close();
});

test("a malformed discovered catalog is diagnosed without overwriting stored catalog data", async () => {
  let catalogWrites = 0;
  let diagnosticWrites = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      writeCatalog() {
        catalogWrites++;
      },
      writeDiagnostic() {
        diagnosticWrites++;
        return true;
      },
    } as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    rebuild: async () => {
      rebuilds++;
    },
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "static" },
      stored: null,
      discover: async () => ({ language: "invalid" }) as never,
    },
  ]);

  await Bun.sleep(20);
  expect(catalogWrites).toBe(0);
  expect(diagnosticWrites).toBe(1);
  expect(rebuilds).toBe(1);
  scheduler.close();
});

test("a rebuild failure after successful persistence retries without rediscovering or writing a diagnostic", async () => {
  let discoveries = 0;
  let catalogWrites = 0;
  let diagnosticWrites = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      writeCatalog() {
        catalogWrites++;
      },
      writeDiagnostic() {
        diagnosticWrites++;
        return true;
      },
    } as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    rebuild: async () => {
      rebuilds++;
      if (rebuilds === 1) throw new Error("router rebuild failed");
    },
    rebuildRetryMs: 5,
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "static" },
      stored: null,
      discover: async () => {
        discoveries++;
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
  ]);

  await Bun.sleep(40);
  expect(discoveries).toBe(1);
  expect(catalogWrites).toBe(1);
  expect(diagnosticWrites).toBe(0);
  expect(rebuilds).toBe(2);
  scheduler.close();
});

test("an overdue TTL catalog persists discovery and rebuilds the runtime snapshot", async () => {
  let written: unknown;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      writeCatalog(_providerId: string, catalog: unknown) {
        written = catalog;
      },
    } as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    now: () => 10_000,
    rebuild: async () => {
      rebuilds++;
    },
  });
  const discovered = {
    language: [{ id: "new-model" }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "ttl", ttlMs: 1_000 },
      stored: {
        catalog: {
          language: [{ id: "old-model" }],
          image: [],
          embedding: [],
          speech: [],
          transcription: [],
          reranking: [],
        },
        refreshedAt: 0,
      },
      discover: async () => discovered,
    },
  ]);

  await Bun.sleep(20);
  expect(written).toEqual(discovered);
  expect(rebuilds).toBe(1);
  scheduler.close();
});

test("a failed TTL refresh preserves last-known-good and waits the host retry interval", async () => {
  let discoveries = 0;
  let catalogWrites = 0;
  let diagnosticWrites = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      writeCatalog() {
        catalogWrites++;
      },
      writeDiagnostic() {
        diagnosticWrites++;
        return true;
      },
    } as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    catalogRetryMs: 20,
    rebuild: async () => {
      rebuilds++;
    },
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "ttl", ttlMs: 1 },
      stored: {
        catalog: {
          language: [{ id: "old-model" }],
          image: [],
          embedding: [],
          speech: [],
          transcription: [],
          reranking: [],
        },
        refreshedAt: 0,
      },
      discover: async () => {
        discoveries++;
        if (discoveries === 1) throw new Error("refresh failed");
        return new Promise<never>(() => {});
      },
    },
  ]);

  await Bun.sleep(10);
  expect(discoveries).toBe(1);
  expect(catalogWrites).toBe(0);
  expect(diagnosticWrites).toBe(1);
  expect(rebuilds).toBe(1);
  await Bun.sleep(30);
  expect(discoveries).toBe(2);
  scheduler.close();
});

test("replacing a job while discovery is in flight discards the late catalog", async () => {
  let resolveDiscovery = (_value: unknown) => {};
  let catalogWrites = 0;
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      writeCatalog() {
        catalogWrites++;
      },
    } as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    rebuild: async () => {
      rebuilds++;
    },
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "static" },
      stored: null,
      discover: async () =>
        new Promise((resolve) => {
          resolveDiscovery = resolve;
        }),
    },
  ]);
  await Bun.sleep(10);
  scheduler.replaceJobs([]);
  resolveDiscovery({ language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] });

  await Bun.sleep(10);
  expect(catalogWrites).toBe(0);
  expect(rebuilds).toBe(0);
  scheduler.close();
});

test("close cancels a pending post-persistence rebuild retry", async () => {
  let rebuilds = 0;
  const scheduler = new CatalogScheduler({
    repository: repository as never,
    diagnostics: ((code: string) => ({
      code,
      summary: code,
      retryable: true,
      occurredAt: new Date().toISOString(),
    })) as never,
    rebuildRetryMs: 10,
    rebuild: async () => {
      rebuilds++;
      throw new Error("rebuild failed");
    },
  });
  scheduler.replaceJobs([
    {
      providerId: "person",
      policy: { kind: "static" },
      stored: null,
      discover: async () => ({
        language: [],
        image: [],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      }),
    },
  ]);

  await Bun.sleep(5);
  expect(rebuilds).toBe(1);
  scheduler.close();
  await Bun.sleep(30);
  expect(rebuilds).toBe(1);
});
