import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { join } from "node:path";
import { AtomicConfigFile } from ".";
import { ageLockWithUnavailableIdentity, child, fixture, waitForFile } from "./test-support";

describe("AtomicConfigFile", () => {
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
    ageLockWithUnavailableIdentity(lockPath);
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
    ageLockWithUnavailableIdentity(`${path}.lock`);

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
});
