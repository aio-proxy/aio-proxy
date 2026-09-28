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
import { InputGroupAddon, InputGroupText } from '@aio-proxy/ui/components/input-group';
import { Label } from '@aio-proxy/ui/components/label';
import { Spinner } from '@aio-proxy/ui/components/spinner';
import { useQuery } from '@tanstack/react-query';
import { RotateCwIcon } from 'lucide-react';
import { useState } from 'react';

import { modelsDevSlugsQueryOptions } from '../../services/models-dev-service';

interface ModelMetadataExtendFieldProps {
  /** The reference in effect: the chosen one, else the match for the model ID, else `''`. */
  readonly slug: string;
  /** `slug` was matched from the model ID rather than chosen. */
  readonly matched: boolean;
  /** Called with a picked model ID, or `undefined` to drop the choice and go back to the match. */
  readonly onValueChange: (next: string | undefined) => void;
}

/**
 * The reference model as one searchable field. It always shows the reference in effect, so there is
 * no separate "change" step: typing searches the catalog, picking writes `extend`, and clearing a
 * chosen reference returns to the automatic match.
 */
export const ModelMetadataExtendField: React.FC<ModelMetadataExtendFieldProps> = ({ slug, matched, onValueChange }) => {
  const [slugQuery, setSlugQuery] = useState(slug);
  const [lastSlug, setLastSlug] = useState(slug);
  // The match loads after mount, and a pick or a clear changes it from outside; the field follows.
  if (slug !== lastSlug) {
    setLastSlug(slug);
    setSlugQuery(slug);
  }
  const slugs = useQuery(modelsDevSlugsQueryOptions());
  const query = slugQuery === slug ? '' : slugQuery.trim().toLowerCase();
  const loaded = slugs.data?.slugs ?? [];
  const base = slug !== '' && !loaded.includes(slug) ? [slug, ...loaded] : loaded;
  // The catalog is thousands of entries; the popup only needs enough to pick from.
  const options = base.filter((option) => query === '' || option.toLowerCase().includes(query)).slice(0, 100);
  const chosen = slug !== '' && !matched;

  return (
    <div className="space-y-1.5">
      <Label htmlFor="metadata-extend" className="sr-only">
        {m['dashboard.routing.editor.metadata_extend_label']()}
      </Label>
      <Combobox
        items={options}
        value={slug === '' ? null : slug}
        inputValue={slugQuery}
        onValueChange={(next: string | null) => {
          if (next === null || next === '') {
            onValueChange(undefined);
            return;
          }
          setSlugQuery(next);
          onValueChange(next);
        }}
        onInputValueChange={setSlugQuery}
        onOpenChange={(open) => {
          // A search abandoned without a pick leaves the reference as it was.
          if (!open) setSlugQuery(slug);
        }}
      >
        <ComboboxInput
          id="metadata-extend"
          className="w-full font-mono text-xs"
          disabled={slugs.isPending && slug === ''}
          aria-label={m['dashboard.routing.editor.metadata_extend_aria_label']()}
          placeholder={
            slugs.isPending
              ? m['dashboard.routing.editor.metadata_extend_loading_placeholder']()
              : m['dashboard.routing.profile.reference_placeholder']()
          }
          showClear={chosen}
          clearLabel={m['dashboard.routing.profile.reference_auto']()}
        >
          {matched && slugQuery === slug ? (
            // Before the chevron, which the input group pins last.
            <InputGroupAddon align="inline-end" className="order-1 pr-0">
              <InputGroupText className="font-sans text-xs font-normal" data-testid="metadata-extend-matched">
                {m['dashboard.routing.profile.reference_matched']()}
              </InputGroupText>
            </InputGroupAddon>
          ) : null}
        </ComboboxInput>
        <ComboboxContent>
          <ComboboxEmpty>{m['dashboard.routing.editor.metadata_extend_empty']()}</ComboboxEmpty>
          <ComboboxList>
            {options.map((option) => (
              <ComboboxItem key={option} value={option} className="font-mono text-xs">
                {option}
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
          {m['dashboard.routing.editor.metadata_extend_loading']()}
        </p>
      ) : slugs.isError ? (
        <div className="flex flex-wrap items-center gap-2" role="alert" data-testid="metadata-extend-status">
          <p className="text-xs text-destructive">{m['dashboard.routing.editor.metadata_extend_error']()}</p>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            data-testid="metadata-extend-retry"
            onClick={() => void slugs.refetch()}
          >
            <RotateCwIcon data-icon="inline-start" aria-hidden="true" />
            {m['dashboard.routing.editor.metadata_extend_retry']()}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid="metadata-extend-status">
          {matched
            ? m['dashboard.routing.profile.reference_matched_hint']()
            : slug === ''
              ? m['dashboard.routing.profile.reference_manual']()
              : m['dashboard.routing.profile.reference_follow']()}
        </p>
      )}
    </div>
  );
};
