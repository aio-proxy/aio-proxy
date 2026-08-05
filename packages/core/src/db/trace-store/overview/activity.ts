import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { DashboardOverviewActivityResponse } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };
type RawActivityRow = { readonly date: string; readonly modelId: string; readonly totalTokens: string };

export function overviewDashboardActivity(
  db: BunSQLiteDatabase,
  options: { readonly now?: Date } = {},
): DashboardOverviewActivityResponse {
  const { from, to } = activityRange(options.now ?? new Date());
  const tokensByDate = new Map<string, Map<string, bigint>>();
  for (const row of all<RawActivityRow>(
    db,
    `select local_day as date, model_dimension as modelId, cast(total_tokens as text) as totalTokens from usage_daily
      where local_day >= ? and local_day <= ?`,
    [from, to],
  )) {
    const tokensByModel = tokensByDate.get(row.date) ?? new Map<string, bigint>();
    tokensByModel.set(row.modelId, (tokensByModel.get(row.modelId) ?? 0n) + parseSqliteInteger(row.totalTokens));
    tokensByDate.set(row.date, tokensByModel);
  }
  const items = [];
  for (let day = new Date(`${from}T00:00:00`); localDate(day) <= to; day = addLocalDays(day, 1)) {
    const date = localDate(day);
    const models = [...(tokensByDate.get(date) ?? new Map<string, bigint>())]
      .filter(([, totalTokens]) => totalTokens !== 0n)
      .sort(([leftModelId, leftTokens], [rightModelId, rightTokens]) =>
        leftTokens === rightTokens ? leftModelId.localeCompare(rightModelId) : leftTokens > rightTokens ? -1 : 1,
      )
      .map(([modelId, totalTokens]) => ({ modelId, totalTokens: totalTokens.toString() }));
    const totalTokens = models.reduce((total, model) => total + BigInt(model.totalTokens), 0n);
    items.push({ date, totalTokens: totalTokens.toString(), models });
  }
  return { from, to, items };
}

function all<T>(db: BunSQLiteDatabase, sql: string, params: readonly SQLQueryBindings[]): T[] {
  return (db as IterableDatabase).$client.query<T, SQLQueryBindings[]>(sql).all(...params);
}

function activityRange(now: Date): { from: string; to: string } {
  return {
    from: localDate(addLocalDays(startOfSundayWeek(now), -51 * 7)),
    to: localDate(now),
  };
}

function startOfSundayWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return addLocalDays(start, -start.getDay());
}

function addLocalDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
