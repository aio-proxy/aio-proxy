import { m } from '@aio-proxy/i18n';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import type React from 'react';
import { useState } from 'react';

import type { ProviderEditorForm } from '../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../lib/constants';

interface ProviderCommonFieldsProps {
  form: ProviderEditorForm;
  mode: ProviderFormMode;
  /** oauth creation: the server assigns `session.providerId`, so there is no id to edit or derive. */
  serverAssignsId: boolean;
}

// Lowercase, every other run of characters collapsed to a dash. The id lands in logs, URLs and config
// keys, so CJK and acronym casing are dropped rather than transliterated.
const providerIdFromName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '');

const idDescription = (mode: ProviderFormMode, pinned: boolean): string => {
  if (mode === ProviderFormMode.Edit) return m['dashboard.providers.form.id_description_locked']();
  return pinned
    ? m['dashboard.providers.form.id_description_pinned']()
    : m['dashboard.providers.form.id_description_auto']();
};

export const ProviderCommonFields: React.FC<ProviderCommonFieldsProps> = ({ form, mode, serverAssignsId }) => {
  // Transient field state, never submitted: the id stops following the name once the user types
  // their own, and the choice is meaningless after the first save.
  const [idPinned, setIdPinned] = useState(false);
  const derivesId = mode === ProviderFormMode.Create && !serverAssignsId && !idPinned;

  return (
    <>
      <div data-testid="provider-form-field-name">
        <form.Field name="name">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m['dashboard.providers.form.label_name']()}</Label>
              <Input
                id={field.name}
                value={field.state.value ?? ''}
                onChange={(e) => {
                  field.handleChange(e.target.value);
                  // Derive while typing so the user sees the id they are about to get and can override it.
                  if (derivesId) form.setFieldValue('id', providerIdFromName(e.target.value));
                }}
                onBlur={field.handleBlur}
                placeholder={m['dashboard.providers.form.placeholder_name']()}
              />
            </Field>
          )}
        </form.Field>
      </div>
      {serverAssignsId ? null : (
        <div data-testid="provider-form-field-id">
          <form.Field name="id">
            {(field) => (
              <Field>
                <Label htmlFor={field.name}>{m['dashboard.providers.form.label_id']()}</Label>
                <Input
                  id={field.name}
                  className="font-mono"
                  value={field.state.value ?? ''}
                  disabled={mode === ProviderFormMode.Edit}
                  onChange={(e) => {
                    setIdPinned(true);
                    field.handleChange(e.target.value);
                  }}
                  placeholder={m['dashboard.providers.form.placeholder_id']()}
                />
                <FieldDescription>{idDescription(mode, idPinned)}</FieldDescription>
              </Field>
            )}
          </form.Field>
        </div>
      )}
    </>
  );
};
