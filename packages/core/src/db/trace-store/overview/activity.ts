import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { DashboardOverviewActivityResponse } from '@aio-proxy/types';
import { addDays, format, parse, startOfWeek } from 'date-fns';
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
  for (let day = parseLocalDay(from); localDate(day) <= to; day = addDays(day, 1)) {
    const date = localDate(day);
    const models = [...(tokensByDate.get(date) ?? new Map<string, bigint>())]
      .filter(([, totalTokens]) => totalTokens !== 0n)
      .sort(([leftModelId, leftTokens], [rightModelId, rightTokens]) =>
        leftTokens === rightTokens ? leftModelId.localeCompare(rightModelId) : Number(leftTokens < rightTokens) * 2 - 1,
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
    from: localDate(addDays(startOfWeek(now, { weekStartsOn: 0 }), -51 * 7)),
    to: localDate(now),
  };
}

function parseLocalDay(date: string): Date {
  return parse(date, 'yyyy-MM-dd', new Date());
}

function localDate(value: Date): string {
  return format(value, 'yyyy-MM-dd');
}
