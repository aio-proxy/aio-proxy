import { m } from '@aio-proxy/i18n';
import type { DashboardSettingsView } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@aio-proxy/ui/components/dialog';
import { Field, FieldError, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { useEffect, useState } from 'react';

import type { SettingsSave } from '../settings-form/settings-form-contract';

const HEADER_CAP = 16;

const contentTypeItems = {
  json: 'JSON',
  protobuf: 'Protobuf',
};

type SettingsOtelDestination = DashboardSettingsView['otel']['destinations'][number];

interface HeaderDraft {
  id: string;
  name: string;
  value: string;
}

interface OtelDraft {
  url: string;
  contentType: 'json' | 'protobuf';
  headers: HeaderDraft[];
}

interface SettingsOtelDialogProps {
  readonly open: boolean;
  readonly disabled: boolean;
  readonly editingIndex: number | undefined;
  readonly destinations: DashboardSettingsView['otel']['destinations'];
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: SettingsSave;
}

let nextHeaderId = 0;

const headerDraft = (name = '', value = ''): HeaderDraft => ({
  id: `header-${nextHeaderId++}`,
  name,
  value,
});

const emptyDraft = (): OtelDraft => ({
  url: '',
  contentType: 'json',
  headers: [headerDraft()],
});

const draftFrom = (destination: SettingsOtelDestination): OtelDraft => {
  const headers = Object.entries(destination.headers).map(([name, value]) => headerDraft(name, value));
  return {
    url: destination.url,
    contentType: destination.contentType,
    headers: headers.length === 0 ? [headerDraft()] : headers,
  };
};

const isPartialHeader = (row: HeaderDraft) => (row.name === '') !== (row.value === '');

const isDuplicateHeaderName = (headers: readonly HeaderDraft[], index: number) => {
  const name = headers[index]?.name;
  if (name === undefined || name === '') return false;
  const key = name.toLowerCase();
  return headers.some((row, rowIndex) => rowIndex < index && row.name !== '' && row.name.toLowerCase() === key);
};

const toDestination = (draft: OtelDraft): SettingsOtelDestination => ({
  url: draft.url.trim(),
  contentType: draft.contentType,
  headers: Object.fromEntries(
    draft.headers.flatMap((row) => (row.name === '' && row.value === '' ? [] : [[row.name, row.value] as const])),
  ),
});

const initialDraft = (
  destinations: DashboardSettingsView['otel']['destinations'],
  editingIndex: number | undefined,
): OtelDraft => {
  const current = editingIndex === undefined ? undefined : destinations[editingIndex];
  return current === undefined ? emptyDraft() : draftFrom(current);
};

export const SettingsOtelDialog: React.FC<SettingsOtelDialogProps> = ({
  open,
  disabled,
  editingIndex,
  destinations,
  onOpenChange,
  onSave,
}) => {
  const [originalDestinations] = useState(() => JSON.stringify(destinations));
  // Indices cannot identify a draft after a list refresh, especially with duplicate entries.
  const stale = editingIndex !== undefined && originalDestinations !== JSON.stringify(destinations);
  useEffect(() => {
    if (open && stale) onOpenChange(false);
  }, [open, stale, onOpenChange]);
  const [defaultValues] = useState(() => initialDraft(destinations, editingIndex));
  const form = useForm({
    defaultValues,
    canSubmitWhenInvalid: true,
    onSubmit: ({ value }) => {
      if (stale) return;
      if (value.url.trim() === '' || value.headers.some(isPartialHeader)) return;
      if (value.headers.some((_, index) => isDuplicateHeaderName(value.headers, index))) return;
      const next = toDestination(value);
      const updated =
        editingIndex === undefined
          ? [...destinations, next]
          : destinations.map((destination, index) => (index === editingIndex ? next : destination));
      // A rejected write has nothing else to restore this draft from, so the dialog stays open
      // until the parent confirms the save.
      onSave({ otel: { destinations: updated } }, { onSuccess: () => onOpenChange(false) });
    },
  });
  const editing = editingIndex !== undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto" closeLabel={m['common.close']()}>
        <DialogHeader>
          <DialogTitle>
            {editing ? m['dashboard.settings.otel_edit_title']() : m['dashboard.settings.otel_add_title']()}
          </DialogTitle>
        </DialogHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void form.handleSubmit();
          }}
        >
          <form.Field
            name="url"
            validators={{
              onSubmit: ({ value }) =>
                value.trim() === '' ? m['dashboard.settings.otel_endpoint_required']() : undefined,
            }}
          >
            {(field) => {
              const invalid = field.state.meta.errors.length > 0;
              return (
                <Field data-invalid={invalid || undefined}>
                  <FieldLabel htmlFor="otel-endpoint">{m['dashboard.settings.otel_endpoint']()}</FieldLabel>
                  <Input
                    id="otel-endpoint"
                    value={field.state.value}
                    disabled={disabled}
                    aria-invalid={invalid || undefined}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                  />
                  <FieldError errors={field.state.meta.errors.map((message) => ({ message: String(message) }))} />
                </Field>
              );
            }}
          </form.Field>
          <form.Field name="contentType">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="otel-content-type">{m['dashboard.settings.otel_content_type']()}</FieldLabel>
                <Select
                  items={contentTypeItems}
                  value={field.state.value}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (value !== 'json' && value !== 'protobuf') return;
                    field.handleChange(value);
                  }}
                >
                  <SelectTrigger id="otel-content-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="protobuf">Protobuf</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
          <form.Field
            name="headers"
            mode="array"
            validators={{
              onSubmit: ({ value }) => (value.some(isPartialHeader) ? m['dashboard.settings.invalid']() : undefined),
            }}
          >
            {(field) => (
              <Field data-invalid={field.state.meta.errors.length > 0 || undefined}>
                <FieldLabel>{m['dashboard.settings.otel_headers']()}</FieldLabel>
                {field.state.value.map((row, index) => (
                  <div key={row.id} className="grid grid-cols-2 gap-2">
                    <form.Field
                      name={`headers[${index}].name` as `headers[${number}].name`}
                      validators={{
                        onSubmit: ({ fieldApi }) =>
                          isDuplicateHeaderName(fieldApi.form.getFieldValue('headers'), index)
                            ? m['dashboard.settings.otel_header_duplicate']()
                            : undefined,
                      }}
                    >
                      {(nameField) => {
                        const invalid = nameField.state.meta.errors.length > 0;
                        return (
                          <Field data-invalid={invalid || undefined}>
                            <FieldLabel htmlFor={`otel-header-name-${row.id}`}>
                              {m['dashboard.settings.otel_header_name']()}
                            </FieldLabel>
                            <Input
                              id={`otel-header-name-${row.id}`}
                              value={nameField.state.value}
                              disabled={disabled}
                              aria-invalid={invalid || undefined}
                              onChange={(event) => nameField.handleChange(event.target.value)}
                            />
                            <FieldError
                              errors={nameField.state.meta.errors.map((message) => ({ message: String(message) }))}
                            />
                          </Field>
                        );
                      }}
                    </form.Field>
                    <form.Field name={`headers[${index}].value` as `headers[${number}].value`}>
                      {(valueField) => (
                        <Field>
                          <FieldLabel htmlFor={`otel-header-value-${row.id}`}>
                            {m['dashboard.settings.otel_header_value']()}
                          </FieldLabel>
                          <Input
                            id={`otel-header-value-${row.id}`}
                            value={valueField.state.value}
                            disabled={disabled}
                            onChange={(event) => valueField.handleChange(event.target.value)}
                          />
                        </Field>
                      )}
                    </form.Field>
                  </div>
                ))}
                <FieldError errors={field.state.meta.errors.map((message) => ({ message: String(message) }))} />
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={disabled || field.state.value.length >= HEADER_CAP}
                  onClick={() => field.pushValue(headerDraft())}
                >
                  {m['dashboard.settings.otel_add_header']()}
                </Button>
              </Field>
            )}
          </form.Field>
          <DialogFooter>
            <Button type="submit" disabled={disabled}>
              {editing ? m['dashboard.settings.otel_save']() : m['dashboard.settings.otel_create']()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
