import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@aio-proxy/ui/components/combobox';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Spinner } from '@aio-proxy/ui/components/spinner';
import { useQuery } from '@tanstack/react-query';
import { RotateCwIcon } from 'lucide-react';
import { useState } from 'react';

import { modelsDevSlugsQueryOptions } from '../../../services/models-dev-service';

interface ModelMetadataExtendFieldProps {
  readonly value: string;
  readonly onValueChange: (next: string | undefined) => void;
}

/** The models.dev slug this model inherits from, plus the state of the catalog behind the picker. */
export const ModelMetadataExtendField: React.FC<ModelMetadataExtendFieldProps> = ({ value, onValueChange }) => {
  const [slugQuery, setSlugQuery] = useState(value);
  const slugs = useQuery(modelsDevSlugsQueryOptions());
  const query = slugQuery.trim().toLowerCase();
  const loaded = slugs.data?.slugs ?? [];
  // The catalog is thousands of entries; the popup only needs enough to pick from.
  const options = loaded.filter((slug) => query === '' || slug.toLowerCase().includes(query)).slice(0, 100);

  return (
    <Field>
      <FieldLabel htmlFor="metadata-extend">{m['dashboard.providers.editor.metadata_extend_label']()}</FieldLabel>
      <Combobox
        items={options}
        value={value === '' ? null : value}
        inputValue={slugQuery}
        onValueChange={(next: string | null) => {
          setSlugQuery(next ?? '');
          onValueChange(next === null || next === '' ? undefined : next);
        }}
        onInputValueChange={setSlugQuery}
      >
        <ComboboxInput
          id="metadata-extend"
          className="w-full font-mono text-xs"
          placeholder={
            slugs.isPending
              ? m['dashboard.providers.editor.metadata_extend_loading']()
              : m['dashboard.providers.editor.metadata_extend_placeholder']()
          }
          showClear={value !== ''}
        />
        <ComboboxContent>
          <ComboboxEmpty>{m['dashboard.providers.editor.metadata_extend_empty']()}</ComboboxEmpty>
          <ComboboxList>
            {options.map((slug) => (
              <ComboboxItem key={slug} value={slug} className="font-mono text-xs">
                {slug}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {slugs.isPending ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
          {/* Hidden from assistive tech: this paragraph is already the live region, and Spinner
              carries its own untranslated status role. */}
          <Spinner className="size-3" aria-hidden="true" />
          {m['dashboard.providers.editor.metadata_extend_loading']()}
        </p>
      ) : slugs.isError ? (
        <div className="flex flex-wrap items-center gap-2" role="alert" data-testid="metadata-extend-status">
          <p className="text-xs text-destructive">{m['dashboard.providers.editor.metadata_extend_error']()}</p>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="metadata-extend-retry"
            onClick={() => void slugs.refetch()}
          >
            <RotateCwIcon data-icon="inline-start" aria-hidden="true" />
            {m['dashboard.providers.editor.metadata_extend_retry']()}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="metadata-extend-status">
          {m['dashboard.providers.editor.metadata_extend_loaded']({ count: loaded.length })}
        </p>
      )}
    </Field>
  );
};
