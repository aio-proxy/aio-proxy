import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function createTempHomes(prefix: string) {
  const homes: string[] = [];
  return {
    cleanup: () => {
      for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
    },
    tempHome: () => {
      const home = mkdtempSync(join(tmpdir(), prefix));
      homes.push(home);
      return home;
    },
  };
}
