import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";

import { AtomicConfigFile } from ".";
import { fixture } from "./test-support";

describe("AtomicConfigFile", () => {
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

  test("returning the exact current object performs a locked read without rewrite or verification", async () => {
    const { path } = fixture('{"one":1}\n');
    const before = statSync(path).mtimeMs;
    let verified = false;
    const result = await new AtomicConfigFile(path).transaction(
      async (current) => ({ next: current, result: current["one"] }),
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
