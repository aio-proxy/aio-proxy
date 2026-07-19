import { CredentialRefreshError } from "@aio-proxy/plugin-sdk";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createFixtureScope, deferred, port } from "./test-support";

const childPath = fileURLToPath(new URL("../../../_test/plugins/refresh-lease-child.ts", import.meta.url));
const fixtures = createFixtureScope();

afterEach(() => fixtures.cleanup());

async function childOutput(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const [output, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`child failed (${exitCode}): ${stderr}`);
  return output;
}

async function waitForLine(child: Bun.Subprocess<"ignore", "pipe", "pipe">, expected: string): Promise<void> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes(expected)) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error(`child exited before printing ${expected}`);
    output += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
}

test("fixture scopes clean only their own temporary directories", () => {
  const firstScope = createFixtureScope();
  const secondScope = createFixtureScope();
  const first = firstScope.open();
  const second = secondScope.open();
  try {
    first.handle.close();
    second.handle.close();
    firstScope.cleanup();

    expect(existsSync(first.home)).toBe(false);
    expect(existsSync(second.home)).toBe(true);
  } finally {
    firstScope.cleanup();
    secondScope.cleanup();
  }
});

test.each([
  ["default and explicit runtime", undefined, "runtime"],
  ["control-plane", "control-plane", "control-plane"],
] as const)(
  "deduplicates concurrent %s refresh calls for one provider in one process",
  async (_name, leftMode, rightMode) => {
    const { handle, repository } = fixtures.open();
    try {
      const credentials = port(repository, "provider-1", leftMode === undefined ? {} : { mode: leftMode });
      const first = await credentials.read();
      const gate = deferred();
      let exchanges = 0;
      const exchange = async () => {
        exchanges += 1;
        await gate.promise;
        return { value: { token: "next-secret" } };
      };

      const leftPromise = credentials.refresh(first.revision, exchange);
      const rightPromise = port(repository, "provider-1", { mode: rightMode }).refresh(first.revision, exchange);
      await Promise.resolve();
      gate.resolve();
      const [left, right] = await Promise.all([leftPromise, rightPromise]);

      expect(exchanges).toBe(1);
      expect(left).toEqual(right);
      expect(left.status).toBe("updated");
    } finally {
      handle.close();
    }
  },
);

test("does not share a refresh flight across repositories with the same provider id", async () => {
  const firstFixture = fixtures.open();
  const secondFixture = fixtures.open();
  const firstGate = deferred();
  const firstStarted = deferred();
  const secondStarted = deferred();
  try {
    const first = port(firstFixture.repository);
    const second = port(secondFixture.repository);
    const firstSnapshot = await first.read();
    const secondSnapshot = await second.read();
    const firstRefresh = first.refresh(firstSnapshot.revision, async () => {
      firstStarted.resolve();
      await firstGate.promise;
      return { value: { token: "first-repository-token" } };
    });
    await firstStarted.promise;

    const secondRefresh = second.refresh(secondSnapshot.revision, async () => {
      secondStarted.resolve();
      return { value: { token: "second-repository-token" } };
    });

    expect(await Promise.race([secondStarted.promise.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true);
    expect(await secondRefresh).toMatchObject({
      status: "updated",
      snapshot: { value: { token: "second-repository-token" } },
    });
    firstGate.resolve();
    await firstRefresh;
  } finally {
    firstGate.resolve();
    firstFixture.handle.close();
    secondFixture.handle.close();
  }
});

test("does not serialize refresh exchanges for different providers", async () => {
  const { handle, repository } = fixtures.open(["provider-1", "provider-2"]);
  try {
    const firstGate = deferred();
    const firstStarted = deferred();
    const first = port(repository, "provider-1");
    const second = port(repository, "provider-2");
    const firstSnapshot = await first.read();
    const secondSnapshot = await second.read();
    const blocked = first.refresh(firstSnapshot.revision, async () => {
      firstStarted.resolve();
      await firstGate.promise;
      return { value: { token: "first-next" } };
    });
    await firstStarted.promise;

    const independent = await second.refresh(secondSnapshot.revision, async () => ({
      value: { token: "second-next" },
    }));

    expect(independent.status).toBe("updated");
    firstGate.resolve();
    await blocked;
  } finally {
    handle.close();
  }
});

test("allows exactly one exchange across two processes sharing one SQLite database", async () => {
  const { home, handle, repository } = fixtures.open();
  const expectedRevision = repository.readAccount("provider-1")?.revision;
  if (expectedRevision === undefined) throw new Error("missing fixture account");
  handle.close();
  const spawn = () =>
    Bun.spawn([process.execPath, childPath, "refresh", home, "provider-1", String(expectedRevision)], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

  const outputs = await Promise.all([childOutput(spawn()), childOutput(spawn())]);

  expect(outputs.join("").match(/^exchange$/gim)).toHaveLength(1);
  expect(outputs.join("").match(new RegExp(`^expected:${expectedRevision}$`, "gim"))).toHaveLength(2);
  expect(outputs.join("").match(/^updated$/gim)).toHaveLength(1);
  expect(outputs.join("").match(/^superseded$/gim)).toHaveLength(1);
});

test("takes over an expired lease after its owner process is killed", async () => {
  const { home, handle, repository } = fixtures.open();
  const owner = Bun.spawn([process.execPath, childPath, "hold", home, "provider-1", "150"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForLine(owner, "acquired");
  owner.kill();
  await owner.exited;

  try {
    const credentials = port(repository);
    const current = await credentials.read();
    const result = await credentials.refresh(current.revision, async () => ({ value: { token: "after-kill" } }));
    expect(result.status).toBe("updated");
  } finally {
    handle.close();
  }
});

test("returns superseded without exchange when the revision changes while waiting for a lease", async () => {
  const { handle, repository } = fixtures.open();
  try {
    const credentials = port(repository);
    const current = await credentials.read();
    expect(repository.tryAcquireRefreshLease("provider-1", "other-owner", Date.now(), Date.now() + 5_000)).toBe(true);
    let exchanges = 0;
    const refreshing = credentials.refresh(current.revision, async () => {
      exchanges += 1;
      return { value: { token: "must-not-run" } };
    });
    await Bun.sleep(20);
    repository.compareAndSwapCredential("provider-1", current.revision, "other-owner", { token: "new-login" });
    repository.releaseRefreshLease("provider-1", "other-owner");

    const result = await refreshing;
    expect(result).toMatchObject({ status: "superseded", snapshot: { value: { token: "new-login" } } });
    expect(exchanges).toBe(0);
  } finally {
    handle.close();
  }
});

test("refresh changes only credential revision and notifies once when clearing an existing diagnostic", async () => {
  const { handle, repository } = fixtures.open();
  let notifications = 0;
  try {
    repository.writeDiagnostic("provider-1", {
      code: "CREDENTIAL_REFRESH_FAILED",
      summary: "Credential refresh failed",
      retryable: true,
      occurredAt: "2026-07-15T00:00:00.000Z",
    });
    const credentials = port(repository, "provider-1", {
      onDiagnosticChanged: () => {
        notifications += 1;
      },
    });
    const before = repository.readAccount("provider-1");
    if (before === null) throw new Error("missing fixture account");

    const result = await credentials.refresh(before.revision, async () => ({
      value: { token: "valid-next" },
      metadata: { label: "Rotated", expiresAt: 2 },
    }));

    expect(result.status).toBe("updated");
    expect(repository.readAccount("provider-1")).toMatchObject({
      revision: before.revision + 1,
      runtimeRevision: before.runtimeRevision,
      label: "Rotated",
      expiresAt: 2,
    });
    expect(repository.readDiagnostics("provider-1")).toEqual([]);
    expect(notifications).toBe(1);
  } finally {
    handle.close();
  }
});

test.each([
  ["network", undefined],
  ["request_timeout", 408],
  ["rate_limited", 429],
  ["upstream_5xx", 503],
] as const)(
  "transient %s refresh failure keeps the old credential without a permanent diagnostic",
  async (reason, status) => {
    const { handle, repository } = fixtures.open();
    try {
      const originalCredential = (await port(repository).read()).value;
      const credentials = port(repository);
      await expect(
        credentials.refresh(1, async () => {
          throw new CredentialRefreshError("Google token refresh failed", {
            retryable: true,
            reason,
            ...(status === undefined ? {} : { status }),
          });
        }),
      ).rejects.toThrow("Google token refresh failed");

      expect(repository.readDiagnostics("provider-1")).toEqual([]);
      expect((await credentials.read()).value).toEqual(originalCredential);
    } finally {
      handle.close();
    }
  },
);
