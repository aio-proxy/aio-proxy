import { RECOVERY_DRAIN_RETRY_MS } from "@aio-proxy/core";
import { ConfigSchema } from "@aio-proxy/types";
import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerState } from "../../src/server-state";
import { cleanup, deferred, flushMicrotasks } from "./test-support";

afterEach(cleanup);

test("server recovery schedules the returned deadline and close prevents an in-flight run from rearming", async () => {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-timer-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const recoveryStarted = deferred();
  const releaseRecovery = deferred();
  let recoveries = 0;
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    __test: {
      async recoverPendingAccountOperations() {
        recoveries++;
        if (recoveries === 1) return {};
        if (recoveries === 2) return { nextRunAt: Date.now() + 100 };
        if (recoveries === 3) {
          recoveryStarted.resolve();
          await releaseRecovery.promise;
          return { nextRunAt: Date.now() + 100 };
        }
        return {};
      },
    },
  } as never);

  try {
    expect(recoveries).toBe(2);
    jest.advanceTimersByTime(99);
    await flushMicrotasks();
    expect(recoveries).toBe(2);
    jest.advanceTimersByTime(1);
    await recoveryStarted.promise;
    expect(recoveries).toBe(3);

    state.close();
    releaseRecovery.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
  } finally {
    releaseRecovery.resolve();
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("close prevents an in-flight rejected recovery from logging or rearming", async () => {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-rejection-close-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const recoveryStarted = deferred();
  const rejectRecovery = deferred();
  let recoveries = 0;
  const logs: unknown[] = [];
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginLogger: (entry) => logs.push(entry),
    __test: {
      async recoverPendingAccountOperations() {
        recoveries++;
        if (recoveries === 1) return {};
        if (recoveries === 2) return { nextRunAt: Date.now() + 100 };
        recoveryStarted.resolve();
        await rejectRecovery.promise;
        throw new Error("secret recovery failure");
      },
    },
  } as never);

  try {
    jest.advanceTimersByTime(100);
    await recoveryStarted.promise;
    expect(recoveries).toBe(3);

    state.close();
    rejectRecovery.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(RECOVERY_DRAIN_RETRY_MS);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
    expect(logs).toEqual([]);
  } finally {
    rejectRecovery.resolve();
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});
