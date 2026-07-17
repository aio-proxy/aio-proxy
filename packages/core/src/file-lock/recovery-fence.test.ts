import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRecoveryFence } from "./recovery-fence";

test.serial("action errors are not translated after the acquisition deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-fence-"));
  const originalSpawn = Bun.spawn;
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("MATCH\n"));
        controller.close();
      },
    }),
    exited: Promise.resolve(0),
  })) as unknown as typeof Bun.spawn);
  const actionError = new Error("action failed");
  try {
    await expect(
      runWithRecoveryFence(
        {
          lockPath: join(dir, "config.lock"),
          staleMs: 60_000,
          heartbeatMs: 10_000,
          deadline: Date.now() + 100,
          timeoutError: () => new Error("acquisition timed out"),
        },
        async () => {
          await Bun.sleep(150);
          throw actionError;
        },
      ),
    ).rejects.toBe(actionError);
  } finally {
    spawn.mockRestore();
    Bun.spawn = originalSpawn;
    rmSync(dir, { recursive: true, force: true });
  }
});
