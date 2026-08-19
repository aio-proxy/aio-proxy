import { m } from '@aio-proxy/i18n';
import { Field, FieldDescription } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Label } from '@aio-proxy/ui/components/label';
import type React from 'react';
import { useState } from 'react';

import type { ProviderEditorForm } from '../../../hooks/use-provider-editor-form';
import { ProviderFormMode } from '../../../lib/constants';

interface IdentityFieldsProps {
  form: ProviderEditorForm;
  mode: ProviderFormMode;
  /** oauth creation: the server assigns `session.providerId`, so the id is shown but not editable. */
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

const idDescription = (mode: ProviderFormMode, pinned: boolean, serverAssignsId: boolean): string => {
  // First: this field is disabled and empty here, so neither "generated from the name" nor "fixed once
  // saved" is true of it — the authorization flow is what fills it in.
  if (serverAssignsId) return m['dashboard.providers.form.id_description_server_assigned']();
  if (mode === ProviderFormMode.Edit) return m['dashboard.providers.form.id_description_locked']();
  return pinned
    ? m['dashboard.providers.form.id_description_pinned']()
    : m['dashboard.providers.form.id_description_auto']();
};

export const IdentityFields: React.FC<IdentityFieldsProps> = ({ form, mode, serverAssignsId }) => {
  // Transient field state, never submitted: the id stops following the name once the user types
  // their own, and the choice is meaningless after the first save.
  const [idPinned, setIdPinned] = useState(false);
  const derivesId = mode === ProviderFormMode.Create && !serverAssignsId && !idPinned;

  return (
    // Name and id sit side by side, as in the prototype, in every mode. The id keeps its cell even when
    // the server assigns it: a field that appears and disappears with the kind moves the name field
    // under the user's cursor, and a disabled input plus its description says more than a gap.
    <div className="grid gap-4 sm:grid-cols-2">
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
      <div data-testid="provider-form-field-id">
        <form.Field name="id">
          {(field) => (
            <Field>
              <Label htmlFor={field.name}>{m['dashboard.providers.form.label_id']()}</Label>
              <Input
                id={field.name}
                className="font-mono"
                // Shown empty, not cleared: naming an api draft derives an id from the name, and
                // switching the kind to oauth must not display that leftover under a description
                // promising the authorization flow will fill the field in. The derived value stays in
                // form state so switching back restores it, and oauth creation never submits it —
                // `startCreateAuthorization` sends only name, proxy and enabled.
                value={serverAssignsId ? '' : (field.state.value ?? '')}
                disabled={mode === ProviderFormMode.Edit || serverAssignsId}
                onChange={(e) => {
                  setIdPinned(true);
                  field.handleChange(e.target.value);
                }}
                // No placeholder where the server assigns the id: nothing is generated from the name
                // there, and the description below already says what fills the field.
                placeholder={serverAssignsId ? undefined : m['dashboard.providers.form.placeholder_id']()}
              />
              <FieldDescription>{idDescription(mode, idPinned, serverAssignsId)}</FieldDescription>
            </Field>
          )}
        </form.Field>
      </div>
    </div>
  );
};
