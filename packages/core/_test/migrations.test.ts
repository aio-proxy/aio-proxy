import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db/migrations.manifest";

test("runtime migrations match the committed Drizzle journal", () => {
  const journal = JSON.parse(
    readFileSync(join(import.meta.dir, "../src/db/migrations/meta/_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string }> };
  expect(MIGRATIONS.map(({ file }) => file)).toEqual(journal.entries.map(({ tag }) => `${tag}.sql`));
  for (const migration of MIGRATIONS) {
    expect(createHash("sha256").update(migration.sql).digest("hex")).toBe(migration.sha256);
  }
});
