import { Database } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DatabaseSchemaTooNewError, MigrationHashMismatchError } from "../error";
import { dbPath } from "../paths";
import { COMPILED_SCHEMA_VERSION, MIGRATIONS, type Migration } from "./migrations.manifest";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export type OpenDbOptions = {
  readonly readonly?: boolean;
  readonly home?: string;
};

export type OpenDbHandle = {
  readonly sqlite: Database;
  readonly db: BunSQLiteDatabase;
  readonly path: string;
  readonly close: () => void;
};

type RegistryEntry = {
  readonly sqlite: Database;
  readonly db: BunSQLiteDatabase;
  readonly path: string;
  refCount: number;
};

const registry = new Map<string, RegistryEntry>();

export function openDb(options: OpenDbOptions = {}): OpenDbHandle {
  const path = resolveDbPath(options);
  const existing = registry.get(path);
  if (existing !== undefined) {
    existing.refCount += 1;
    return borrow(existing);
  }

  ensureDbFile(path);
  const sqlite = options.readonly === true ? new Database(path, { readonly: true }) : new Database(path);
  applyPragmas(sqlite, options.readonly === true);
  applyMigrations(sqlite, options.readonly === true);

  const entry: RegistryEntry = {
    sqlite,
    db: drizzle({ client: sqlite }),
    path,
    refCount: 1,
  };
  registry.set(path, entry);
  return borrow(entry);
}

function borrow(entry: RegistryEntry): OpenDbHandle {
  let closed = false;

  return {
    sqlite: entry.sqlite,
    db: entry.db,
    path: entry.path,
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      entry.refCount -= 1;
      if (entry.refCount === 0) {
        registry.delete(entry.path);
        entry.sqlite.close();
      }
    },
  };
}

function resolveDbPath(options: OpenDbOptions): string {
  if (options.home !== undefined) {
    return resolve(options.home, "aio-proxy.db");
  }
  return dbPath();
}

function ensureDbFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    chmodSync(dirname(path), 0o700);
  }

  if (!existsSync(path)) {
    closeSync(openSync(path, "w", 0o600));
  }

  if (process.platform !== "win32") {
    chmodSync(path, 0o600);
  }
}

function applyPragmas(sqlite: Database, readonly: boolean): void {
  if (!readonly) {
    sqlite.exec("PRAGMA journal_mode = WAL");
  }
  sqlite.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec("PRAGMA synchronous = NORMAL");
}

function applyMigrations(sqlite: Database, readonly: boolean): void {
  const currentVersion = readUserVersion(sqlite);
  if (currentVersion > COMPILED_SCHEMA_VERSION) {
    throw new DatabaseSchemaTooNewError(currentVersion, COMPILED_SCHEMA_VERSION);
  }

  if (readonly) {
    return;
  }

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      applyMigration(sqlite, migration);
    }
  }
}

function applyMigration(sqlite: Database, migration: Migration): void {
  const actualSha256 = createHash("sha256").update(migration.sql).digest("hex");
  if (actualSha256 !== migration.sha256) {
    throw new MigrationHashMismatchError(migration, actualSha256);
  }

  const runMigration = sqlite.transaction(() => {
    sqlite.exec(migration.sql);
    sqlite.exec(`PRAGMA user_version = ${migration.version}`);
  });
  runMigration();
}

function readUserVersion(sqlite: Database): number {
  const row = sqlite.query("PRAGMA user_version").get();
  if (typeof row !== "object" || row === null) {
    return 0;
  }

  const value = Object.values(row).at(0);
  return typeof value === "number" ? value : 0;
}
