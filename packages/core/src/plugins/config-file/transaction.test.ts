import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AtomicConfigFile } from ".";
import { fixture } from "./test-support";

describe("AtomicConfigFile", () => {
  test("reads every supported config format", async () => {
    const { dir } = fixture();
    const cases = [
      ["config.json", "{format: 'json',}"],
      ["config.jsonc", "{format: 'jsonc',}"],
      ["config.yaml", "format: yaml\n"],
      ["config.yml", "format: yml\n"],
      ["config.toml", 'format = "toml"\n'],
    ] as const;

    for (const [name, contents] of cases) {
      const path = join(dir, name);
      writeFileSync(path, contents);
      expect(await new AtomicConfigFile(path).read()).toEqual({ format: name.slice("config.".length) });
    }
  });

  test("does not rewrite TOML as another format", async () => {
    const { dir } = fixture();
    const path = join(dir, "config.toml");
    const original = "one = 1\n";
    writeFileSync(path, original);

    await expect(new AtomicConfigFile(path).replace((current) => ({ ...current, two: 2 }))).rejects.toThrow(
      "TOML config updates are not supported",
    );
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("preserves YAML syntax when updating YAML config", async () => {
    const { dir } = fixture();

    for (const name of ["config.yaml", "config.yml"]) {
      const path = join(dir, name);
      writeFileSync(path, "one: 1\n");
      await new AtomicConfigFile(path).replace((current) => ({ ...current, two: 2 }));
      expect(readFileSync(path, "utf8")).toContain("two: 2");
    }
  });

  test("rejects unsupported config formats", async () => {
    const { dir } = fixture();
    const path = join(dir, "config.txt");
    writeFileSync(path, "{}");
    await expect(new AtomicConfigFile(path).read()).rejects.toThrow("Unsupported config format: .txt");

    const missingPath = join(dir, "missing.txt");
    await expect(new AtomicConfigFile(missingPath).replace(() => ({ value: true }))).rejects.toThrow(
      "Unsupported config format: .txt",
    );
    expect(existsSync(missingPath)).toBe(false);
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
