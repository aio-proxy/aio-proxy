import { m } from '@aio-proxy/i18n';
import type { AliasSelectRow } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@aio-proxy/ui/components/select';
import { Switch } from '@aio-proxy/ui/components/switch';
import { ArrowRightIcon, Trash2Icon } from 'lucide-react';
import type { FC } from 'react';

import {
  type AliasEditorIssue,
  type AliasRowDraft,
  aliasControlId,
  fromRowDraft,
  toRowDraft,
} from '../lib/alias-editor';
import { ProviderVariantConditions } from './provider-variant-conditions';

interface ProviderVariantRowProps {
  readonly aliasName: string;
  /** Index into the stored rows: the row's identity for edits and for issue anchors. */
  readonly index: number;
  readonly row: AliasSelectRow;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly onChange: (row: AliasSelectRow) => void;
  readonly onRemove: () => void;
}

/**
 * Every control reads the stored row, so the row prop is the only state. A per-row form would be a second
 * copy, and removing a row renumbers the ones after it: React would hand the outgoing row's form to its
 * successor, whose own edit then writes the wrong condition. Nothing to hand over, nothing to go stale.
 */
export const ProviderVariantRow: FC<ProviderVariantRowProps> = ({
  aliasName,
  index,
  row,
  models,
  issues,
  onChange,
  onRemove,
}) => {
  const draft = toRowDraft(row);
  const codes = new Set(issues.map((issue) => issue.code));
  const controlId = aliasControlId(aliasName, index);
  const commit = (patch: Partial<AliasRowDraft>) => onChange(fromRowDraft({ ...draft, ...patch }));

  return (
    <div className="space-y-2 border-b pb-3 last:border-b-0 last:pb-0" data-testid="provider-variant-row">
      <div className="grid items-center gap-2 lg:grid-cols-[repeat(3,minmax(0,1fr))_auto_minmax(0,1.25fr)_auto]">
        <ProviderVariantConditions
          draft={draft}
          controlId={controlId}
          invalid={
            codes.has('variant-when-required') ||
            codes.has('variant-when-duplicate') ||
            codes.has('variant-effort-blank')
          }
          onCommit={commit}
        />
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 lg:contents">
          <ArrowRightIcon className="mx-auto size-3.5 text-muted-foreground" aria-hidden="true" />
          <Select
            value={draft.model}
            onValueChange={(model) => {
              if (model === null) return;
              commit({ model });
            }}
          >
            <SelectTrigger
              id={`${controlId}-target`}
              size="sm"
              className="w-full font-mono"
              aria-label={m['dashboard.providers.form.variant_target']()}
              aria-invalid={codes.has('target-missing')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {models.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={m['dashboard.providers.form.remove_variant']()}
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          size="sm"
          checked={draft.preserve}
          onCheckedChange={(preserve) => commit({ preserve: Boolean(preserve) })}
        />
        {m['dashboard.providers.form.variant_preserve']()}
      </label>
    </div>
  );
};
