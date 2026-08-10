import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Field } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';

interface HeaderRow {
  readonly id: number;
  readonly key: string;
  readonly value: string;
}

interface ProviderHeadersFieldProps {
  readonly value: Readonly<Record<string, string>> | undefined;
  readonly onChange: (value: Readonly<Record<string, string>>) => void;
}

const headerRecord = (rows: readonly HeaderRow[]): Readonly<Record<string, string>> =>
  Object.fromEntries(rows.filter((row) => row.key.trim() !== '').map((row) => [row.key.trim(), row.value]));

export const ProviderHeadersField: React.FC<ProviderHeadersFieldProps> = ({ value, onChange }) => {
  const nextId = useRef(Object.keys(value ?? {}).length);
  const [rows, setRows] = useState<readonly HeaderRow[]>(() =>
    Object.entries(value ?? {}).map(([key, headerValue], id) => ({ id, key, value: headerValue })),
  );

  const changeRows = (change: (current: readonly HeaderRow[]) => readonly HeaderRow[]) => {
    setRows((current) => {
      const next = change(current);
      onChange(headerRecord(next));
      return next;
    });
  };

  return (
    <div data-testid="provider-form-field-headers" className="space-y-3">
      <Label>{m['dashboard.providers.form.label_headers']()}</Label>
      {rows.map((row, index) => {
        const keyId = `provider-header-key-${row.id}`;
        const valueId = `provider-header-value-${row.id}`;
        return (
          <div key={row.id} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Field>
              <Label htmlFor={keyId}>{m['dashboard.providers.form.label_header_key']()}</Label>
              <Input
                id={keyId}
                value={row.key}
                onChange={(event) =>
                  changeRows((current) =>
                    current.map((candidate) =>
                      candidate.id === row.id ? { ...candidate, key: event.target.value } : candidate,
                    ),
                  )
                }
              />
            </Field>
            <Field>
              <Label htmlFor={valueId}>{m['dashboard.providers.form.label_header_value']()}</Label>
              <Input
                id={valueId}
                value={row.value}
                onChange={(event) =>
                  changeRows((current) =>
                    current.map((candidate) =>
                      candidate.id === row.id ? { ...candidate, value: event.target.value } : candidate,
                    ),
                  )
                }
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={m['dashboard.providers.form.remove_header']({ key: row.key || String(index + 1) })}
              onClick={() => changeRows((current) => current.filter((candidate) => candidate.id !== row.id))}
            >
              <Trash2Icon />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          const id = nextId.current++;
          changeRows((current) => [...current, { id, key: '', value: '' }]);
        }}
      >
        <PlusIcon data-icon="inline-start" />
        {m['dashboard.providers.form.add_header']()}
      </Button>
    </div>
  );
};
