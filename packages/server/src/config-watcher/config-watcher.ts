import { type Stats, unwatchFile, watchFile } from "node:fs";

export type ConfigWatcher = {
  readonly close: () => void;
};

export function watchConfigFile(configPath: string, onChange: () => Promise<unknown>): ConfigWatcher {
  let pendingReload: ReturnType<typeof setTimeout> | undefined;
  const changed = (current: Stats, previous: Stats) => {
    if (current.ino === previous.ino && current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    if (pendingReload !== undefined) {
      return;
    }
    pendingReload = setTimeout(() => {
      pendingReload = undefined;
      void onChange();
    }, 25);
  };
  watchFile(configPath, { interval: 100 }, changed);
  return {
    close() {
      if (pendingReload !== undefined) {
        clearTimeout(pendingReload);
      }
      unwatchFile(configPath, changed);
    },
  };
}
