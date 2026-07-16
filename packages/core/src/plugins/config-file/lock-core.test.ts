import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { basename } from "node:path";
import { AtomicConfigFile } from ".";
import { child, fixture } from "./test-support";

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
  }, 15_000);

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

  test("changed recovery-marker content remains active without creating a competing fence", async () => {
    const { dir, path } = fixture("{}\n");
    const lockPath = `${path}.lock`;
    const recoveryPath = `${lockPath}.recovery.changed-owner`;
    writeFileSync(recoveryPath, JSON.stringify({ pid: 999_999, owner: "changed-owner", createdAt: 0 }));
    utimesSync(recoveryPath, new Date(0), new Date(0));
    const realReadFile = fsPromises.readFile.bind(fsPromises);
    let reads = 0;
    let resumeThirdRead!: () => void;
    const thirdReadPaused = new Promise<void>((resolve) => {
      resumeThirdRead = resolve;
    });
    let reachedThirdRead!: () => void;
    const thirdReadReached = new Promise<void>((resolve) => {
      reachedThirdRead = resolve;
    });
    const readFile = spyOn(fsPromises, "readFile").mockImplementation((async (target: never, options: never) => {
      if (String(target) === recoveryPath) {
        reads++;
        if (reads === 2) {
          writeFileSync(recoveryPath, JSON.stringify({ pid: process.pid, owner: "replacement-owner", createdAt: 1 }));
        } else if (reads === 3) {
          reachedThirdRead();
          await thirdReadPaused;
        }
      }
      return realReadFile(target, options);
    }) as never);
    const controller = new AbortController();
    const pending = new AtomicConfigFile(path).replace((current) => current, { signal: controller.signal });

    try {
      await thirdReadReached;
      expect(readdirSync(dir).filter((name) => name.startsWith(`${basename(lockPath)}.recovery.`))).toEqual([
        `${basename(lockPath)}.recovery.changed-owner`,
      ]);
    } finally {
      resumeThirdRead();
      controller.abort(new Error("stop"));
      await pending.catch(() => {});
      readFile.mockRestore();
    }
  });
});
