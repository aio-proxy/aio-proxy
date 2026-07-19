import { expect, test } from "bun:test";
import { CatalogScheduler } from "../../src/catalog-scheduler";

const repository = {
  writeCatalog() {},
  writeDiagnostic() {
    return true;
  },
  clearDiagnostic() {
    return true;
  },
};

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
  let resolveDiagnostic = () => {};
  let resolveDiscovery = () => {};
  const diagnosticWritten = new Promise<void>((resolve) => {
    resolveDiagnostic = resolve;
  });
  const discoveryResolved = new Promise<void>((resolve) => {
    resolveDiscovery = resolve;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const scheduler = new CatalogScheduler({
    repository: {
      ...repository,
      writeCatalog() {
        catalogWrites++;
      },
      writeDiagnostic() {
        diagnosticWrites++;
        resolveDiagnostic();
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
  try {
    scheduler.replaceJobs([
      {
        providerId: "person",
        policy: { kind: "static" },
        stored: null,
        discover: async () => {
          await Bun.sleep(20);
          resolveDiscovery();
          return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
        },
      },
    ]);

    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("timed out waiting for the deadline diagnostic and late discovery")),
        1_000,
      );
    });
    await Promise.race([Promise.all([diagnosticWritten, discoveryResolved]), deadline]);
    await Bun.sleep(0);
    expect(diagnosticWrites).toBe(1);
    expect(catalogWrites).toBe(0);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    scheduler.close();
  }
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
