import { AtomicConfigFile } from "@aio-proxy/core";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchConfigFile } from "./config-watcher";

test("ignores config lock lifecycle events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aio-proxy-config-watcher-"));
  const configPath = join(directory, "settings.yaml");
  let reloads = 0;
  const watcher = watchConfigFile(configPath, async () => {
    reloads++;
  });

  try {
    await new AtomicConfigFile(configPath).replace((current) => current);
    await Bun.sleep(75);
    expect(reloads).toBe(0);
  } finally {
    watcher.close();
    await rm(directory, { force: true, recursive: true });
  }
});
