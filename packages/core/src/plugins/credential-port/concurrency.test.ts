import {
  childOutput,
  childPath,
  deferred,
  diagnosticFactory,
  expect,
  openFixture,
  port,
  test,
  waitForLine,
} from "./test-support";

test("deduplicates concurrent refresh calls for one provider in one process", async () => {
  const { handle, repository } = openFixture();
  try {
    const credentials = port(repository);
    const first = await credentials.read();
    const gate = deferred();
    let exchanges = 0;
    const exchange = async () => {
      exchanges += 1;
      await gate.promise;
      return { value: { token: "next-secret" } };
    };

    const leftPromise = credentials.refresh(first.revision, exchange);
    const rightPromise = port(repository).refresh(first.revision, exchange);
    await Promise.resolve();
    gate.resolve();
    const [left, right] = await Promise.all([leftPromise, rightPromise]);

    expect(exchanges).toBe(1);
    expect(left).toEqual(right);
    expect(left.status).toBe("updated");
  } finally {
    handle.close();
  }
});

test("does not share a refresh flight across repositories with the same provider id", async () => {
  const firstFixture = openFixture();
  const secondFixture = openFixture();
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
  const { handle, repository } = openFixture(["provider-1", "provider-2"]);
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
  const { home, handle, repository } = openFixture();
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
  const { home, handle, repository } = openFixture();
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
  const { handle, repository } = openFixture();
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
  const { handle, repository } = openFixture();
  let notifications = 0;
  try {
    repository.writeDiagnostic("provider-1", diagnosticFactory()("CREDENTIAL_REFRESH_FAILED", { retryable: true }));
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
