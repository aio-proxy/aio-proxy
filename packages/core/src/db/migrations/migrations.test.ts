import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../index";
import { MIGRATIONS } from "../migrations.manifest";

test("runtime migrations match the committed Drizzle journal", () => {
  const journal = JSON.parse(readFileSync(join(import.meta.dir, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  expect(MIGRATIONS.map(({ file }) => file)).toEqual(journal.entries.map(({ tag }) => `${tag}.sql`));
  for (const migration of MIGRATIONS) {
    expect(createHash("sha256").update(migration.sql).digest("hex")).toBe(migration.sha256);
  }
});

test("applied migrations deploy the trace persistence contract", () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-migrations-"));
  const handle = openDb({ home });
  try {
    const tables = handle.sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map(({ name }) => name);
    expect(tables).toEqual(
      expect.arrayContaining(["trace_span", "usage_daily", "session_affinity", "session_response"]),
    );

    const dailyColumns = handle.sqlite
      .query<{ name: string }, []>("PRAGMA table_info(usage_daily)")
      .all()
      .map(({ name }) => name);
    expect(dailyColumns).toContain("local_day");
    expect(dailyColumns).toContain("model_dimension");
    expect(dailyColumns.some((name) => name.includes("provider"))).toBeFalse();
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
