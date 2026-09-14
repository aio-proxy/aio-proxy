import { m } from '@aio-proxy/i18n';
import type { DashboardApiKeyMutation, DashboardSettingsView } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { Label } from '@aio-proxy/ui/components/label';
import { Switch } from '@aio-proxy/ui/components/switch';
import { DicesIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';

import { apiKeysSchema, type SettingsSave } from './settings-form-contract';
import type { SettingsFormApi } from './use-settings-form';

interface ApiKeyRow {
  readonly id: string;
  readonly key: string;
  readonly label: string;
}

interface SettingsApiKeysGroupProps {
  readonly disabled: boolean;
  readonly form: SettingsFormApi;
  readonly settings: DashboardSettingsView;
  readonly onSave: SettingsSave;
}

const rowsFromSettings = (settings: DashboardSettingsView): readonly ApiKeyRow[] =>
  settings.apiKeys.map((entry, index) => ({ id: `stored-${index}`, key: entry.key, label: entry.label ?? '' }));

// A row left without a key but carrying a label cannot be saved, so it is reported as an error
// rather than dropped. A row with nothing in it at all is just an unused Add click.
// Emptiness is the literal empty string, matching the schema's `min(1)`: whitespace is a valid
// credential the proxy compares byte for byte, so trimming here would drop a usable key.
const isIncomplete = (row: ApiKeyRow) => row.key === '' && row.label.trim() !== '';

const mutationEntries = (rows: readonly ApiKeyRow[]): readonly DashboardApiKeyMutation[] =>
  rows.flatMap((row): readonly DashboardApiKeyMutation[] => {
    if (row.key === '') return [];
    const label = row.label.trim();
    return [{ key: row.key, ...(label === '' ? {} : { label }) }];
  });

// The generated key never leaves the browser until the row is saved, so the platform CSPRNG
// is the whole requirement here — 24 bytes of entropy behind the conventional `sk-` prefix.
const generateApiKey = () =>
  `sk-${Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;

export const SettingsApiKeysGroup: React.FC<SettingsApiKeysGroupProps> = ({ disabled, form, settings, onSave }) => {
  const nextDraftId = useRef(0);
  const [rows, setRows] = useState<readonly ApiKeyRow[]>(() => rowsFromSettings(settings));
  const [seen, setSeen] = useState(settings.apiKeys);

  // Server state wins on a content change, the same rule `SettingsForm` applies to every other
  // group through `form.reset`. Query structural sharing keeps the array identity across refetches
  // that changed nothing, so a draft only loses to an edit that actually landed — including this
  // form's own save, whose response reseeds the rows instead of a bespoke draft cleanup.
  if (seen !== settings.apiKeys) {
    setSeen(settings.apiKeys);
    setRows(rowsFromSettings(settings));
  }

  const entries = mutationEntries(rows);
  const parsed = apiKeysSchema.safeParse(entries);
  const incomplete = rows.some(isIncomplete);
  const patchRow = (id: string, patch: Partial<ApiKeyRow>) =>
    setRows((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));

  return (
    <Card data-testid="settings-group-api-keys">
      <CardHeader>
        <CardTitle>
          <h2>{m['dashboard.settings.api_keys_group']()}</h2>
        </CardTitle>
        <CardAction>
          <form.Field name="requireApiKey">
            {(field) => (
              <Field orientation="horizontal">
                <Label htmlFor={field.name}>{m['dashboard.settings.api_keys_require']()}</Label>
                <Switch
                  id={field.name}
                  checked={field.state.value}
                  disabled={disabled}
                  aria-label={m['dashboard.settings.api_keys_require']()}
                  onCheckedChange={(requireApiKey) => {
                    field.handleChange(requireApiKey);
                    onSave({ requireApiKey });
                  }}
                />
              </Field>
            )}
          </form.Field>
        </CardAction>
        <CardDescription>
          {m['dashboard.settings.api_keys_description']()}
          {settings.requireApiKey ? null : (
            <span className="mt-1 block text-destructive">{m['dashboard.settings.api_keys_require_off']()}</span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m['dashboard.settings.api_keys_empty']()}</p>
        ) : null}
        {rows.map((row) => (
          // The labels sit above the inputs, so the remove control aligns to the input line
          // rather than to the row box — `items-end` plus a control-height button centers it.
          <div key={row.id} className="flex items-end gap-2">
            <div className="flex-[2] space-y-1">
              <Label htmlFor={`api-key-value-${row.id}`} className="text-xs">
                {m['dashboard.settings.api_keys_value']()}
              </Label>
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
              {isIncomplete(row) ? (
                <p className="text-xs text-destructive">{m['dashboard.settings.api_keys_value_required']()}</p>
              ) : null}
            </div>
            <div className="flex-1 space-y-1">
              <Label htmlFor={`api-key-label-${row.id}`} className="text-xs">
                {m['dashboard.settings.api_keys_label']()}
                <span className="font-normal text-muted-foreground">{m['dashboard.settings.optional']()}</span>
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
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => {
              // Row identity is local to this form; randomUUID is unavailable on remote HTTP origins.
              const id = `draft-${nextDraftId.current++}`;
              setRows((current) => [...current, { id, key: '', label: '' }]);
            }}
          >
            <PlusIcon data-icon="inline-start" />
            {m['dashboard.settings.api_keys_add']()}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled || incomplete || !parsed.success}
            onClick={() => {
              if (incomplete || !parsed.success) return;
              onSave({ apiKeys: parsed.data });
            }}
          >
            {m['dashboard.settings.api_keys_save']()}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};
