import type { Database } from "bun:sqlite";
import { createAccountRepository } from "./accounts";
import { createPendingOperationsRepository } from "./pending-operations";
import { createPluginStateRepository } from "./plugin-state";
import type { PluginRepository } from "./types";

export * from "./types";

export function createPluginRepository(sqlite: Database): PluginRepository {
  return {
    ...createPluginStateRepository(sqlite),
    ...createAccountRepository(sqlite),
    ...createPendingOperationsRepository(sqlite),
  };
}
