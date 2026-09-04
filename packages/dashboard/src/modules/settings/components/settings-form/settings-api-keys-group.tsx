import { m } from '@aio-proxy/i18n';
import type { DashboardApiKeyMutation, DashboardSettingsMutationInput, DashboardSettingsView } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';

import { apiKeysSchema } from './settings-form-contract';

interface ApiKeyRow {
  readonly id: number;
  readonly retain?: number;
  readonly key: string;
  readonly label: string;
}

interface SettingsApiKeysGroupProps {
  readonly disabled: boolean;
  readonly settings: DashboardSettingsView;
  readonly onSave: (input: DashboardSettingsMutationInput) => void;
}

const rowsFromSettings = (settings: DashboardSettingsView): readonly ApiKeyRow[] =>
  settings.apiKeys.map((entry, index) => ({ id: index, key: entry.key, label: entry.label ?? '', retain: index }));

const mutationEntries = (rows: readonly ApiKeyRow[]): readonly DashboardApiKeyMutation[] =>
  rows.flatMap((row): readonly DashboardApiKeyMutation[] => {
    const label = row.label.trim() === '' ? {} : { label: row.label.trim() };
    if (row.retain !== undefined) return [{ retain: row.retain, ...label }];
    if (row.key.trim() === '') return [];
    return [{ key: row.key.trim(), ...label }];
  });

export const SettingsApiKeysGroup: React.FC<SettingsApiKeysGroupProps> = ({ disabled, settings, onSave }) => {
  const [rows, setRows] = useState<readonly ApiKeyRow[]>(() => rowsFromSettings(settings));
  const [revision, setRevision] = useState(settings.apiKeysRevision);

  // `retain` indexes address the authored array this revision digests. A save elsewhere in the
  // page re-fetches the same keys, so key on the digest and keep drafts unless the keys changed.
  if (revision !== settings.apiKeysRevision) {
    setRevision(settings.apiKeysRevision);
    setRows(rowsFromSettings(settings));
  }

  const entries = mutationEntries(rows);
  const parsed = apiKeysSchema.safeParse(entries);

  return (
    <Card data-testid="settings-group-api-keys">
      <CardHeader>
        <CardTitle>
          <h2>{m['dashboard.settings.api_keys_group']()}</h2>
        </CardTitle>
        <CardDescription>{m['dashboard.settings.api_keys_description']()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m['dashboard.settings.api_keys_empty']()}</p>
        ) : null}
        {rows.map((row) => (
          <div key={row.id} className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor={`api-key-label-${row.id}`} className="text-xs">
                {m['dashboard.settings.api_keys_label']()}
              </Label>
              <Input
                id={`api-key-label-${row.id}`}
                className="h-7 text-xs"
                value={row.label}
                disabled={disabled}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry) => (entry.id === row.id ? { ...entry, label: event.target.value } : entry)),
                  )
                }
              />
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor={`api-key-value-${row.id}`} className="text-xs">
                {m['dashboard.settings.api_keys_value']()}
              </Label>
              <Input
                id={`api-key-value-${row.id}`}
                className="h-7 font-mono text-xs"
                type={row.retain === undefined ? 'text' : 'password'}
                autoComplete="off"
                value={row.key}
                readOnly={row.retain !== undefined}
                disabled={disabled}
                placeholder={row.retain === undefined ? undefined : m['dashboard.settings.api_keys_stored']()}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry) => (entry.id === row.id ? { ...entry, key: event.target.value } : entry)),
                  )
                }
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled}
              aria-label={m['dashboard.settings.api_keys_remove']({
                label: row.label || m['dashboard.settings.api_keys_unnamed'](),
              })}
              onClick={() => setRows((current) => current.filter((entry) => entry.id !== row.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => {
              setRows((current) => [
                ...current,
                { id: Math.max(-1, ...current.map((entry) => entry.id)) + 1, key: '', label: '' },
              ]);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            {m['dashboard.settings.api_keys_add']()}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled || !parsed.success}
            onClick={() => {
              if (!parsed.success) return;
              onSave({ apiKeys: parsed.data, apiKeysRevision: settings.apiKeysRevision });
            }}
          >
            {m['dashboard.settings.api_keys_save']()}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
