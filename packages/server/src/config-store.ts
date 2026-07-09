import { readFile, rename, writeFile } from "node:fs/promises";

export class ConfigPathMissingError extends Error {
  constructor() {
    super("config file path is not configured");
    this.name = "ConfigPathMissingError";
  }
}

export class ConfigReloadRejectedError extends Error {
  constructor(reason: string) {
    super(`config reload rejected: ${reason}`);
    this.name = "ConfigReloadRejectedError";
  }
}

export type ConfigReloadOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export type ConfigStoreOptions = {
  readonly getConfigPath: () => string | undefined;
  readonly reload: () => Promise<ConfigReloadOutcome>;
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
      const result = await options.reload();
      if (!result.ok) {
        // ponytail: reload validates the persisted file; on rejection restore the prior valid config so disk never diverges from the live snapshot.
        await writeFile(tmpPath, raw, "utf8");
        await rename(tmpPath, configPath);
        throw new ConfigReloadRejectedError(result.error);
      }
    });
    // ponytail: a rejected write must not poison the mutex — swallow it on `chain`, surface it on `run`.
    chain = run.catch(() => {});
    return run;
  };

  return { mutateProviders };
}
