import { m } from '@aio-proxy/i18n';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { useForm } from '@tanstack/react-form';
import type React from 'react';

interface ProviderSearchFieldProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export const ProviderSearchField: React.FC<ProviderSearchFieldProps> = ({ value, onChange }) => {
  const form = useForm({ defaultValues: { search: value } });

  return (
    <form.Field name="search">
      {(field) => (
        <Field>
          {/* The placeholder alone would leave the input nameless once text is typed into it. */}
          <FieldLabel htmlFor="provider-search" className="sr-only">
            {m['dashboard.providers.card.search_placeholder']()}
          </FieldLabel>
          <Input
            id="provider-search"
            data-testid="provider-search"
            value={field.state.value}
            placeholder={m['dashboard.providers.card.search_placeholder']()}
            onChange={(event) => {
              field.handleChange(event.target.value);
              onChange(event.target.value);
            }}
          />
        </Field>
      )}
    </form.Field>
  );
};
