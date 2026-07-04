import { watch } from "node:fs";
import { basename, dirname } from "node:path";

export type ConfigWatcher = {
  readonly close: () => void;
};

export function watchConfigFile(configPath: string, onChange: () => Promise<unknown>): ConfigWatcher {
  const targetName = basename(configPath);
  let pendingReload: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(dirname(configPath), (event, filename) => {
    const changedName = filename === null ? undefined : filename;
    if (event === "change" && changedName !== undefined && changedName !== targetName) {
      return;
    }
    if (pendingReload !== undefined) {
      return;
    }
    pendingReload = setTimeout(() => {
      pendingReload = undefined;
      void onChange();
    }, 25);
  });
  return {
    close() {
      if (pendingReload !== undefined) {
        clearTimeout(pendingReload);
      }
      watcher.close();
    },
  };
}
