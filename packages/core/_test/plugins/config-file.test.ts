import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicConfigCommitUncertainError, AtomicConfigFile, CONFIG_LOCK_WAIT_MS } from "../../src/plugins/config-file";

const homes: string[] = [];
const child = join(import.meta.dir, "config-lock-child.ts");

function fixture(text = '{"providers":{}}\n'): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "aio-proxy-config-file-"));
  homes.push(dir);
  const path = join(dir, "config.jsonc");
  writeFileSync(path, text, { mode: 0o640 });
  return { dir, path };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("AtomicConfigFile", () => {
  test("serializes two processes updating different keys without a lost update", async () => {
    const { path } = fixture("{}\n");
    const first = Bun.spawn([process.execPath, child, "update", path, "one", "1"], { stdout: "pipe", stderr: "pipe" });
    const second = Bun.spawn([process.execPath, child, "update", path, "two", "2"], { stdout: "pipe", stderr: "pipe" });
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ one: "1", two: "2" });
  });

  test("recovers a lock whose owning process was killed", async () => {
    const { path } = fixture("{}\n");
    const holder = Bun.spawn([process.execPath, child, "hold", path], { stdout: "pipe", stderr: "pipe" });
    const reader = holder.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("locked");
    holder.kill("SIGKILL");
    await holder.exited;

    await new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ recovered: true });
  });

  test("serializes concurrent stale-lock recovery without deleting a replacement owner", async () => {
    const { path } = fixture("{}\n");
    writeFileSync(
      `${path}.lock`,
      `${JSON.stringify({ pid: 999_999, owner: "dead", createdAt: Date.now() })}${" ".repeat(1_000_000)}`,
    );
    const children = Array.from({ length: 12 }, (_, index) =>
      Bun.spawn([process.execPath, child, "update", path, `key${index}`, String(index)], {
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    expect(await Promise.all(children.map((process) => process.exited))).toEqual(Array(12).fill(0));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(
      Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`key${index}`, String(index)])),
    );
  });

  test("a recovery owner blocks replacement lock acquisition until recovery completes", async () => {
    const { path } = fixture("{}\n");
    const recoveryPath = `${path}.lock.recovery.recovery-owner`;
    writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, owner: "recovery", createdAt: Date.now() }));
    const update = new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));
    await Bun.sleep(100);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
    unlinkSync(recoveryPath);
    await update;
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ recovered: true });
  });

  test("a stale recovery marker is reclaimed even when its PID was reused", async () => {
    const { path } = fixture("{}\n");
    const recoveryPath = `${path}.lock.recovery.reused-owner`;
    writeFileSync(
      recoveryPath,
      JSON.stringify({ pid: process.pid, owner: "reused", createdAt: 0, starttime: "DIFFERENT" }),
    );
    utimesSync(recoveryPath, new Date(0), new Date(0));

    await new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ recovered: true });
  });

  test("an aged malformed recovery marker is reclaimed", async () => {
    const { path } = fixture("{}\n");
    const recoveryPath = `${path}.lock.recovery.partial-owner`;
    writeFileSync(recoveryPath, "");
    utimesSync(recoveryPath, new Date(0), new Date(0));

    await new AtomicConfigFile(path).replace((current) => ({ ...current, recovered: true }));

    expect(existsSync(recoveryPath)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ recovered: true });
  });

  test("a process identity lookup that ignores termination is force-killed and bounded", async () => {
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
          Bun.sleep(2_500).then(() => {
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
  });

  test("a released stdout reader cannot make process identity cleanup reject", async () => {
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
    })) as typeof Bun.spawn;
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

  test("a stale main lock with unavailable live identity is not stolen", async () => {
    const { path } = fixture("{}\n");
    const lockPath = `${path}.lock`;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, owner: "unknown", createdAt: 0, starttime: "RECORDED" }),
    );
    utimesSync(lockPath, new Date(0), new Date(0));
    const originalSpawn = Bun.spawn;
    Bun.spawn = () => {
      throw new Error("ps unavailable");
    };
    let completed = false;
    const update = new AtomicConfigFile(path)
      .replace((current) => ({ ...current, recovered: true }))
      .then(() => {
        completed = true;
      });
    try {
      await Bun.sleep(100);
      expect(completed).toBe(false);
      unlinkSync(lockPath);
      await update;
    } finally {
      Bun.spawn = originalSpawn;
      if (existsSync(lockPath)) unlinkSync(lockPath);
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

  test("release fencing prevents a former owner from unlinking a replacement lock", async () => {
    const { dir, path } = fixture("{}\n");
    const lockPath = `${path}.lock`;
    const unlinkPaused = join(dir, "unlink-paused");
    const resumeUnlink = join(dir, "resume-unlink");
    const realUnlink = fsPromises.unlink.bind(fsPromises);
    let intercepted = false;
    const unlink = spyOn(fsPromises, "unlink").mockImplementation(async (target) => {
      if (target === lockPath && !intercepted) {
        intercepted = true;
        writeFileSync(unlinkPaused, "paused");
        await waitForFile(resumeUnlink);
      }
      return realUnlink(target);
    });

    let finishFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let firstEntered!: () => void;
    const firstDidEnter = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = new AtomicConfigFile(path).replace(async (current) => {
      firstEntered();
      await firstCanFinish;
      return { ...current, first: true };
    });

    let finishReplacement!: () => void;
    const replacementCanFinish = new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
    let replacementEntered!: () => void;
    let didEnterReplacement = false;
    const replacementDidEnter = new Promise<void>((resolve) => {
      replacementEntered = resolve;
    });

    try {
      await firstDidEnter;
      finishFirst();
      await waitForFile(unlinkPaused);
      utimesSync(lockPath, new Date(0), new Date(0));

      const replacement = new AtomicConfigFile(path).replace(async (current) => {
        didEnterReplacement = true;
        replacementEntered();
        await replacementCanFinish;
        return { ...current, replacement: true };
      });
      await Bun.sleep(100);
      expect(didEnterReplacement).toBe(false);
      writeFileSync(resumeUnlink, "resume");
      await first;
      await replacementDidEnter;
      expect(existsSync(lockPath)).toBe(true);

      finishReplacement();
      await replacement;
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ first: true, replacement: true });
    } finally {
      writeFileSync(resumeUnlink, "resume");
      finishFirst();
      finishReplacement();
      unlink.mockRestore();
      await first.catch(() => {});
    }
  });

  test("an old owner's heartbeat never refreshes a replacement lock", async () => {
    const { path } = fixture("{}\n");
    const holder = Bun.spawn([process.execPath, child, "hold", path], { stdout: "pipe", stderr: "pipe" });
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    const lockPath = `${path}.lock`;
    unlinkSync(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "replacement", createdAt: Date.now() }));
    const before = statSync(lockPath).mtimeMs;
    await Bun.sleep(10_100);
    expect(statSync(lockPath).mtimeMs).toBe(before);
    holder.kill("SIGKILL");
    await holder.exited;
  }, 15_000);

  test("a stale former owner cannot rename or release a replacement lock after it resumes", async () => {
    const { path } = fixture("{}\n");
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const update = new AtomicConfigFile(path).replace(async (current) => {
      entered();
      await paused;
      return { ...current, staleOwnerWrite: true };
    });
    await didEnter;

    const lockPath = `${path}.lock`;
    utimesSync(lockPath, new Date(0), new Date(0));
    let finishReplacement!: () => void;
    const replacementCanFinish = new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
    let replacementEntered!: () => void;
    const replacementDidEnter = new Promise<void>((resolve) => {
      replacementEntered = resolve;
    });
    const replacement = new AtomicConfigFile(path).replace(async (current) => {
      replacementEntered();
      await replacementCanFinish;
      return { ...current, replacement: true };
    });
    await replacementDidEnter;
    const replacementOwner = JSON.parse(readFileSync(lockPath, "utf8")).owner;
    resume();

    await expect(update).rejects.toThrow("Config lock ownership lost");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
    expect(JSON.parse(readFileSync(lockPath, "utf8")).owner).toBe(replacementOwner);
    finishReplacement();
    await replacement;
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ replacement: true });
  });

  test("a same-object mutation does not hold the recovery fence for its whole callback", async () => {
    const { path } = fixture("{}\n");
    const config = new AtomicConfigFile(path);
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = config.transaction(async (current) => {
      entered();
      await paused;
      return { next: current, result: "first" };
    });
    await didEnter;
    utimesSync(`${path}.lock`, new Date(0), new Date(0));

    let secondEntered = false;
    const second = config.replace((current) => {
      secondEntered = true;
      return { ...current, second: true };
    });
    const secondResult = second.then(() => undefined);
    const deadline = Date.now() + 2_000;
    while (!secondEntered) {
      if (Date.now() >= deadline) throw new Error("replacement did not enter");
      await Bun.sleep(5);
    }

    resume();
    await expect(first).rejects.toThrow("Config lock ownership lost");
    await secondResult;
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ second: true });
  });

  test("preserves mode and trailing newline on success", async () => {
    const { path } = fixture('{"one":1}\n');
    chmodSync(path, 0o640);
    await new AtomicConfigFile(path).replace((current) => ({ ...current, two: 2 }));
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });

  test("verify failure restores exact bytes and mode before releasing the lock", async () => {
    const original = '{\n  "one": 1\n}\n';
    const { path } = fixture(original);
    chmodSync(path, 0o604);
    const config = new AtomicConfigFile(path);
    let sawCandidate = false;

    await expect(
      config.replace((current) => ({ ...current, two: 2 }), {
        async verify() {
          sawCandidate = JSON.parse(readFileSync(path, "utf8")).two === 2;
          expect(Bun.file(`${path}.lock`).size).toBeGreaterThan(0);
          throw new Error("verify failed");
        },
      }),
    ).rejects.toThrow("verify failed");

    expect(sawCandidate).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(statSync(path).mode & 0o777).toBe(0o604);
  });

  test("a committed candidate is successful even when lock cleanup fails", async () => {
    const { dir, path } = fixture("{}\n");
    try {
      await expect(
        new AtomicConfigFile(path).replace((current) => ({ ...current, committed: true }), {
          async verify() {
            chmodSync(dir, 0o500);
          },
        }),
      ).resolves.toBeUndefined();
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ committed: true });
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a stale former owner never rolls back over a replacement config after verify", async () => {
    const { path } = fixture("{}\n");
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const update = new AtomicConfigFile(path).replace((current) => ({ ...current, candidate: true }), {
      async verify() {
        entered();
        await paused;
        throw new Error("verify failed");
      },
    });
    await didEnter;

    const lockPath = `${path}.lock`;
    utimesSync(lockPath, new Date(0), new Date(0));
    let finishReplacement!: () => void;
    const replacementCanFinish = new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
    let replacementCommitted!: () => void;
    const replacementDidCommit = new Promise<void>((resolve) => {
      replacementCommitted = resolve;
    });
    const replacement = new AtomicConfigFile(path).replace(() => ({ newer: true }), {
      async verify() {
        replacementCommitted();
        await replacementCanFinish;
      },
    });
    await replacementDidCommit;
    resume();

    await expect(update).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ newer: true });
    finishReplacement();
    await replacement;
  });

  test("returning the exact current object performs a locked read without rewrite or verification", async () => {
    const { path } = fixture('{"one":1}\n');
    const before = statSync(path).mtimeMs;
    let verified = false;
    const result = await new AtomicConfigFile(path).transaction(
      async (current) => ({ next: current, result: current.one }),
      {
        verify: async () => {
          verified = true;
        },
      },
    );
    expect(result).toBe(1);
    expect(verified).toBe(false);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  test("provider digests are stable across recursive object key order", async () => {
    const { path } = fixture(JSON.stringify({ providers: { demo: { z: 1, nested: { b: 2, a: 1 } } } }));
    const config = new AtomicConfigFile(path);
    const first = await config.providerEntryDigest("demo");
    writeFileSync(path, JSON.stringify({ providers: { demo: { nested: { a: 1, b: 2 }, z: 1 } } }));
    expect(await config.providerEntryDigest("demo")).toBe(first);
  });
});
