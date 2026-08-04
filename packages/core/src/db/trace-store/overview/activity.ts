import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { DashboardOverviewActivityResponse } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };
type RawActivityRow = { readonly date: string; readonly requestCount: string };

export function overviewDashboardActivity(db: BunSQLiteDatabase, year: number): DashboardOverviewActivityResponse {
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  const counts = new Map(
    all<RawActivityRow>(
      db,
      `select strftime('%Y-%m-%d', ended_at / 1000, 'unixepoch', 'localtime') as date,
        cast(count(*) as text) as requestCount from trace_span
      where parent_span_id is null and ended_at >= ? and ended_at < ? group by date`,
      [start.getTime(), end.getTime()],
    ).map((row) => [row.date, parseSqliteInteger(row.requestCount).toString()] as const),
  );
  const days = [];
  for (const day = new Date(start); day < end; day.setDate(day.getDate() + 1)) {
    const date = localDate(day);
    days.push({ date, requestCount: counts.get(date) ?? '0' });
  }
  return { year, days };
}

function all<T>(db: BunSQLiteDatabase, sql: string, params: readonly SQLQueryBindings[]): T[] {
  return (db as IterableDatabase).$client.query<T, SQLQueryBindings[]>(sql).all(...params);
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
