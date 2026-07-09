import { readFile, rename, writeFile } from "node:fs/promises";

export class ConfigPathMissingError extends Error {
  constructor() {
    super("config file path is not configured");
    this.name = "ConfigPathMissingError";
  }
}

export type ConfigStoreOptions = {
  readonly getConfigPath: () => string | undefined;
  readonly reload: () => Promise<unknown>;
};

export type ConfigStore = {
  readonly mutateProviders: (fn: (record: Record<string, unknown>) => Record<string, unknown>) => Promise<void>;
};

export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  // Promise chain mutex — serialize concurrent writes
  let chain = Promise.resolve();

  const mutateProviders = (fn: (record: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
    const run = chain.then(async () => {
      const configPath = options.getConfigPath();
      if (configPath === undefined) {
        throw new ConfigPathMissingError();
      }
      // Read raw JSON — do NOT reserialize from parsed Config to preserve on-disk field order and future-added fields
      const raw = await readFile(configPath, "utf8");
      const parsed: Record<string, unknown> = JSON.parse(raw);
      const providers =
        typeof parsed.providers === "object" && parsed.providers !== null && !Array.isArray(parsed.providers)
          ? (parsed.providers as Record<string, unknown>)
          : {};
      const newProviders = fn(providers);
      const updated = { ...parsed, providers: newProviders };
      const tmpPath = `${configPath}.tmp`;
      // Write to tmp then rename atomically
      await writeFile(tmpPath, JSON.stringify(updated, null, 2), "utf8");
      await rename(tmpPath, configPath);
      // Reload state to pick up the new config
      await options.reload();
    });
    // ponytail: a rejected write must not poison the mutex — swallow it on `chain`, surface it on `run`.
    chain = run.catch(() => {});
    return run;
  };

  return { mutateProviders };
}
