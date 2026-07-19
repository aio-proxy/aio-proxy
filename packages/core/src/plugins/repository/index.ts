import type { Database } from "bun:sqlite";

import type { PluginRepository } from "./types";

import { createAccountRepository } from "./accounts";
import { createPendingOperationsRepository } from "./pending-operations";
import { createPluginStateRepository } from "./plugin-state";

export * from "./types";

export function createPluginRepository(sqlite: Database): PluginRepository {
  return {
    ...createPluginStateRepository(sqlite),
    ...createAccountRepository(sqlite),
    ...createPendingOperationsRepository(sqlite),
  };
}
