import { m } from '@aio-proxy/i18n';
import type { SyncPreview, SyncStatus } from '@aio-proxy/types';

const sensitiveKey = /(password|secret|token|api[-_]?key|credential|authorization|refresh)/iu;

export function redactSyncValue(value: unknown, key?: string): unknown {
  if (key !== undefined && sensitiveKey.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map((item) => redactSyncValue(item));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSyncValue(entryValue, entryKey)]),
  );
}

export function renderSyncStatus(status: SyncStatus, json: boolean): string {
  if (json) return JSON.stringify(redactSyncValue(status));
  const backend =
    status.backend === null ? m['cli.sync.no_backend']() : `${status.backend.plugin}/${status.backend.capability}`;
  return [
    m['cli.sync.status_line']({ state: status.state, backend }),
    m['cli.sync.provider_count']({ count: String(status.providers.length) }),
    m['cli.sync.pending_count']({ count: String(status.pendingOperations) }),
  ].join('\n');
}

export function renderSyncPreview(preview: SyncPreview, json: boolean): string {
  const safe = redactSyncValue(preview) as SyncPreview;
  if (json) return JSON.stringify(safe);
  const lines: string[] = [
    m['cli.sync.preview_id']({ previewId: preview.previewId }),
    m['cli.sync.preview_expires']({ expiresAt: new Date(preview.expiresAt).toISOString() }),
    m['cli.sync.preview_rows']({ count: String(preview.rows.length) }),
  ];
  for (const row of preview.rows) {
    lines.push(
      m['cli.sync.preview_row']({
        objectId: row.objectId,
        change: row.change,
        secretChange: row.secretChange,
        choices: row.choices.join(', '),
      }),
    );
    lines.push(`  ${m['cli.sync.preview_local']()}: ${JSON.stringify(safeRowValue(row.local))}`);
    lines.push(`  ${m['cli.sync.preview_cloud']()}: ${JSON.stringify(safeRowValue(row.cloud))}`);
    lines.push(
      `  ${m['cli.sync.preview_dependencies']()}: ${row.dependencies.length === 0 ? m['cli.sync.no_backend']() : row.dependencies.join(', ')}`,
    );
  }
  if (preview.retainedSharedPlugins.length > 0)
    lines.push(m['cli.sync.retained_plugins']({ plugins: preview.retainedSharedPlugins.join(', ') }));
  return lines.join('\n');
}

function safeRowValue(value: SyncPreview['rows'][number]['local']): unknown {
  return redactSyncValue(value);
}
