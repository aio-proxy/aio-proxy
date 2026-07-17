import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { AtomicConfigFile, CONFIG_LOCK_WAIT_MS } from ".";
import {
  ageLockWithUnavailableIdentity,
  fixture,
  PROCESS_CLEANUP_TEST_BUDGET_MS,
  PROCESS_CLEANUP_TEST_TIMEOUT_MS,
} from "./test-support";

describe("AtomicConfigFile", () => {
  test.serial(
    "a process identity lookup that ignores termination is force-killed and bounded",
    async () => {
      const { path } = fixture("{}\n");
      const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
      const originalSpawn = mutableBun.spawn;
      const killSignals: unknown[] = [];
      mutableBun.spawn = (() => {
        const stdout = new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            return new Promise<void>(() => {});
          },
        });
        return {
          stdout,
          exited: new Promise<number>(() => {}),
          kill(signal?: unknown) {
            killSignals.push(signal);
          },
        } as unknown as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn;
      const pending = new AtomicConfigFile(path).replace((current) => current);
      try {
        await expect(
          Promise.race([
            pending,
            Bun.sleep(PROCESS_CLEANUP_TEST_BUDGET_MS).then(() => {
              throw new Error("config identity cleanup exceeded its budget");
            }),
          ]),
        ).resolves.toBeUndefined();
        expect(killSignals.length).toBeGreaterThan(0);
        expect(killSignals.every((signal) => signal === 9)).toBe(true);
      } finally {
        mutableBun.spawn = originalSpawn;
        void pending.catch(() => {});
      }
    },
    PROCESS_CLEANUP_TEST_TIMEOUT_MS,
  );

  test.serial("a released stdout reader cannot make process identity cleanup reject", async () => {
    const { path } = fixture("{}\n");
    const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
    const originalSpawn = mutableBun.spawn;
    const killSignals: unknown[] = [];
    mutableBun.spawn = (() => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("MATCH\n"));
          controller.close();
        },
      }),
      exited: new Promise<number>(() => {}),
      kill(signal?: unknown) {
        killSignals.push(signal);
      },
    })) as unknown as typeof Bun.spawn;
    const pending = new AtomicConfigFile(path).replace((current) => current);
    try {
      await expect(
        Promise.race([
          pending,
          Bun.sleep(2_500).then(() => {
            throw new Error("config cleanup rejection exceeded its budget");
          }),
        ]),
      ).resolves.toBeUndefined();
      expect(killSignals.every((signal) => signal === 9)).toBe(true);
    } finally {
      mutableBun.spawn = originalSpawn;
      void pending.catch(() => {});
    }
  });

  test("a main lock is recovered when its live PID has a different start identity", async () => {
    const { path } = fixture("{}\n");
    const lockPath = `${path}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, owner: "reused", createdAt: Date.now(), starttime: "DIFFERENT" }),
    );
    const originalSpawn = Bun.spawn;
    Bun.spawn = (() => {
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("MATCH\n"));
          controller.close();
        },
      });
      return { stdout, exited: Promise.resolve(0) } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;
    try {
      await new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ recovered: true });
    } finally {
      Bun.spawn = originalSpawn;
    }
  });

  test("a stale main lock with unavailable live identity is recovered", async () => {
    const { path } = fixture("{}\n");
    const lockPath = `${path}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, owner: "unknown", createdAt: 0, starttime: "RECORDED" }),
    );
    ageLockWithUnavailableIdentity(lockPath);
    const originalSpawn = Bun.spawn;
    Bun.spawn = () => {
      throw new Error("ps unavailable");
    };
    const update = new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));
    try {
      await expect(
        Promise.race([
          update,
          Bun.sleep(500).then(() => {
            throw new Error("stale config lock with unavailable identity was not recovered");
          }),
        ]),
      ).resolves.toBeUndefined();
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ recovered: true });
    } finally {
      Bun.spawn = originalSpawn;
      if (existsSync(lockPath)) unlinkSync(lockPath);
      await update.catch(() => {});
    }
  });

  test("a stale recovery fence with unavailable live identity is recovered", async () => {
    const { path } = fixture("{}\n");
    const recoveryPath = `${path}.lock.recovery.unknown-owner`;
    writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, owner: "unknown-owner", createdAt: 0 }));
    utimesSync(recoveryPath, new Date(0), new Date(0));
    const update = new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));
    try {
      await expect(
        Promise.race([
          update,
          Bun.sleep(500).then(() => {
            throw new Error("stale config recovery fence with unavailable identity was not recovered");
          }),
        ]),
      ).resolves.toBeUndefined();
      expect(existsSync(recoveryPath)).toBe(false);
    } finally {
      if (existsSync(recoveryPath)) unlinkSync(recoveryPath);
      await update.catch(() => {});
    }
  });

  test("a live recovery fence is never stolen because its heartbeat is old", async () => {
    const { path } = fixture("{}\n");
    const recoveryPath = `${path}.lock.recovery.live-owner`;
    const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(process.pid)], { stdout: "pipe" });
    const starttime = new TextDecoder().decode(ps.stdout).trim();
    writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, owner: "live-owner", createdAt: 0, starttime }));
    utimesSync(recoveryPath, new Date(0), new Date(0));

    let completed = false;
    const update = new AtomicConfigFile(path)
      .replace((current) => ({ ...current, recovered: true }))
      .then(() => {
        completed = true;
      });
    try {
      await Bun.sleep(100);
      expect(existsSync(recoveryPath)).toBe(true);
      expect(completed).toBe(false);
      unlinkSync(recoveryPath);
      await update;
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ recovered: true });
    } finally {
      if (existsSync(recoveryPath)) unlinkSync(recoveryPath);
      await update.catch(() => {});
    }
  });

  test("a live recovery fence with unavailable identity returns a bounded timeout", async () => {
    const { path } = fixture("{}\n");
    const recoveryPath = `${path}.lock.recovery.unknown-owner`;
    writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, owner: "unknown-owner", createdAt: 0 }));
    const now = spyOn(Date, "now");
    let tick = 0;
    now.mockImplementation(() => {
      tick += CONFIG_LOCK_WAIT_MS;
      return tick;
    });
    try {
      await expect(new AtomicConfigFile(path).replace((current) => current)).rejects.toThrow(
        "Timed out waiting for config recovery fence",
      );
      expect(existsSync(recoveryPath)).toBe(true);
    } finally {
      now.mockRestore();
      unlinkSync(recoveryPath);
    }
  });

  test.serial("config treats Windows lock owners as alive without probing the PID", async () => {
    const { path } = fixture("{}\n");
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, owner: "windows-owner", createdAt: Date.now() }));
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ESRCH" });
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("still owned")), 100);
    try {
      await expect(
        new AtomicConfigFile(path).replace((current) => ({ ...current, stolen: true }), { signal: controller.signal }),
      ).rejects.toThrow("still owned");
      expect(kill).not.toHaveBeenCalled();
      expect(readFileSync(lockPath, "utf8")).toContain("windows-owner");
    } finally {
      clearTimeout(timeout);
      kill.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  test.serial("config treats non-Error liveness failures as alive", async () => {
    const { path } = fixture("{}\n");
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, JSON.stringify({ pid: 999_999, owner: "unknown-owner", createdAt: Date.now() }));
    const kill = spyOn(process, "kill").mockImplementation(() => {
      throw Symbol("kill-failure");
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("still owned")), 100);
    try {
      await expect(
        new AtomicConfigFile(path).replace((current) => ({ ...current, stolen: true }), { signal: controller.signal }),
      ).rejects.toThrow("still owned");
      expect(readFileSync(lockPath, "utf8")).toContain("unknown-owner");
    } finally {
      clearTimeout(timeout);
      kill.mockRestore();
    }
  });
});
