import { afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];

export const child = join(import.meta.dir, "../../../_test/plugins/config-lock-child.ts");
export const PROCESS_CLEANUP_TEST_BUDGET_MS = 5_000;
export const PROCESS_CLEANUP_TEST_TIMEOUT_MS = 7_000;

export function fixture(text = '{"providers":{}}\n'): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "aio-proxy-config-file-"));
  homes.push(dir);
  const path = join(dir, "config.jsonc");
  writeFileSync(path, text, { mode: 0o640 });
  return { dir, path };
}

export function ageLockWithUnavailableIdentity(lockPath: string): void {
  const { starttime: _starttime, ...record } = JSON.parse(readFileSync(lockPath, "utf8"));
  writeFileSync(lockPath, JSON.stringify(record));
  utimesSync(lockPath, new Date(0), new Date(0));
}

export async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
