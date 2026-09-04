import { m } from '@aio-proxy/i18n';
import type { DashboardApiKeyMutation, DashboardSettingsMutationInput, DashboardSettingsView } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Input } from '@aio-proxy/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { Label } from '@aio-proxy/ui/components/label';
import { DicesIcon, PlusIcon, Trash2Icon } from 'lucide-react';
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

// The generated key never leaves the browser until the row is saved, so the platform CSPRNG
// is the whole requirement here — 24 bytes of entropy behind the conventional `sk-` prefix.
const generateApiKey = () =>
  `sk-${Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;

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
  const patchRow = (id: number, patch: Partial<ApiKeyRow>) =>
    setRows((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

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
        {rows.map((row) => {
          const stored = row.retain !== undefined;
          return (
            // The labels sit above the inputs, so the remove control aligns to the input line
            // rather than to the row box — `items-end` plus a control-height button centers it.
            <div key={row.id} className="flex items-end gap-2">
              <div className="flex-[2] space-y-1">
                <Label htmlFor={`api-key-value-${row.id}`} className="text-xs">
                  {m['dashboard.settings.api_keys_value']()}
                </Label>
                {stored ? (
                  <Input
                    id={`api-key-value-${row.id}`}
                    className="font-mono text-xs"
                    type="password"
                    autoComplete="off"
                    value={row.key}
                    readOnly
                    disabled={disabled}
                    placeholder={m['dashboard.settings.api_keys_stored']()}
                  />
                ) : (
                  <InputGroup>
                    <InputGroupInput
                      id={`api-key-value-${row.id}`}
                      className="font-mono text-xs"
                      type="text"
                      autoComplete="off"
                      value={row.key}
                      disabled={disabled}
                      placeholder="sk-"
                      onChange={(event) => patchRow(row.id, { key: event.target.value })}
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        size="icon-xs"
                        disabled={disabled}
                        aria-label={m['dashboard.settings.api_keys_generate']()}
                        onClick={() => patchRow(row.id, { key: generateApiKey() })}
                      >
                        <DicesIcon />
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                )}
              </div>
              <div className="flex-1 space-y-1">
                <Label htmlFor={`api-key-label-${row.id}`} className="text-xs">
                  {m['dashboard.settings.api_keys_label']()}
                </Label>
                <Input
                  id={`api-key-label-${row.id}`}
                  className="text-xs"
                  value={row.label}
                  disabled={disabled}
                  onChange={(event) => patchRow(row.id, { label: event.target.value })}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                aria-label={m['dashboard.settings.api_keys_remove']({
                  label: row.label || m['dashboard.settings.api_keys_unnamed'](),
                })}
                onClick={() => setRows((current) => current.filter((entry) => entry.id !== row.id))}
              >
                <Trash2Icon />
              </Button>
            </div>
          );
        })}
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
