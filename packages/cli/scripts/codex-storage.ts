import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function listFiles(path: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await listFiles(join(path, entry.name), relative)));
    else result.push(relative);
  }
  return result;
}

export async function inspectCodexStorage(codexHome: string, sqliteHome: string): Promise<string> {
  const homeFiles = await listFiles(codexHome);
  const sqliteHomeFiles = await listFiles(sqliteHome);
  const files = homeFiles.map((file) => `codex-home/${file}`);
  files.push(...sqliteHomeFiles.map((file) => `sqlite-home/${file}`));
  const sqliteFiles = files.filter((file) => /\.(sqlite|db|sqlite3)$/i.test(file));
  const rolloutFiles = files.filter((file) => /\.jsonl$/i.test(file));
  if (sqliteFiles.length === 0) {
    return `storage blocked: no SQLite file materialized; sqlite_home files=${sqliteHomeFiles.length}, codex-home files=${homeFiles.length}, rollout files=${rolloutFiles.length}`;
  }
  const { Database } = await import('bun:sqlite');
  const descriptions: string[] = [];
  for (const relative of sqliteFiles) {
    const [location, ...parts] = relative.split('/');
    const path = join(location === 'sqlite-home' ? sqliteHome : codexHome, ...parts);
    const database = new Database(path, { readonly: true, strict: true });
    try {
      const tables = database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const threadTable = tables.some((table) => table.name === 'threads');
      const fields = threadTable
        ? (database.query('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map((field) => field.name)
        : [];
      let threadSummary = '';
      if (threadTable) {
        const rows = database.query('SELECT model_provider, history_mode, archived FROM threads').all() as Array<{
          model_provider?: string;
          history_mode?: string;
          archived?: number;
        }>;
        const modes = [...new Set(rows.map((row) => row.history_mode ?? 'null'))].join('|') || '(none)';
        const providers = [...new Set(rows.map((row) => row.model_provider ?? 'null'))].join('|') || '(none)';
        const archived = rows.filter((row) => row.archived === 1).length;
        const spawnTable = tables.some((table) => table.name === 'thread_spawn_edges');
        const spawnFields = spawnTable
          ? (database.query('PRAGMA table_info(thread_spawn_edges)').all() as Array<{ name: string }>).map(
              (field) => field.name,
            )
          : [];
        const spawnRows = spawnTable
          ? (database.query('SELECT COUNT(*) AS count FROM thread_spawn_edges').get() as { count: number }).count
          : 0;
        threadSummary = `;threadRows=${rows.length};providers=${providers};historyModes=${modes};archived=${archived};spawnEdges=${spawnRows};spawnFields=${spawnFields.join('|') || '(absent)'}`;
      }
      descriptions.push(
        `${relative}:tables=${tables.map((table) => table.name).join('|') || '(none)'};threads=${fields.join('|') || '(absent)'}${threadSummary}`,
      );
    } finally {
      database.close();
    }
  }
  const rolloutSummary: string[] = [];
  for (const relative of rolloutFiles) {
    const [location, ...parts] = relative.split('/');
    const path = join(location === 'sqlite-home' ? sqliteHome : codexHome, ...parts);
    const lines = (await readFile(path, 'utf8')).split('\n').filter((line) => line.length > 0);
    const metadata = lines
      .map((line) => {
        try {
          return JSON.parse(line) as { type?: string; payload?: { model_provider?: string } };
        } catch {
          return {};
        }
      })
      .find((row) => row.type === 'session_meta');
    const typeCounts = new Map<string, number>();
    for (const line of lines) {
      try {
        const row = JSON.parse(line) as { type?: string };
        if (row.type !== undefined) typeCounts.set(row.type, (typeCounts.get(row.type) ?? 0) + 1);
      } catch {
        // The line count is still useful when a rollout contains an unknown record.
      }
    }
    const types = [...typeCounts.entries()].map(([type, count]) => `${type}:${count}`).join('|') || '(none)';
    rolloutSummary.push(
      `${relative}:lines=${lines.length};types=${types};sessionMetaProvider=${metadata?.payload?.model_provider ?? 'absent'}`,
    );
  }
  return `storage inspected: ${descriptions.join(', ')}; rollout=${rolloutSummary.join(', ') || '(none)'}; configured sqlite_home=${sqliteHomeFiles.length > 0 ? 'used' : 'ignored'}`;
}
