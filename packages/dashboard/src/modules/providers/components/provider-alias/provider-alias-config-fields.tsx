import { m } from '@aio-proxy/i18n';
import type { AliasConfig } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { FieldError } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { useForm } from '@tanstack/react-form';
import { ArrowRightIcon, Trash2Icon } from 'lucide-react';
import { type FC, useState } from 'react';

import {
  type AliasEditorIssue,
  type AliasEditResult,
  aliasControlId,
  type ProviderAlias,
} from '../../lib/alias-editor';
import { aliasEditErrorMessage, aliasIssueMessage, type VisibleEditError } from '../../lib/alias-editor-copy';

interface ProviderAliasConfigFieldsProps {
  readonly alias: ProviderAlias;
  readonly aliasName: string;
  readonly config: AliasConfig;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly onAliasChange: (alias: ProviderAlias) => void;
  readonly onRename: (name: string) => AliasEditResult;
  readonly onRemove: () => void;
}

export const ProviderAliasConfigFields: FC<ProviderAliasConfigFieldsProps> = ({
  alias,
  aliasName,
  config,
  models,
  issues,
  onAliasChange,
  onRename,
  onRemove,
}) => {
  const [editError, setEditError] = useState<VisibleEditError | null>(null);
  // Only the name is held in a form: a rename the record cannot take (duplicate, or emptied) still has
  // to leave the typed text in the box. Every other control reads the stored config, as the variant
  // rows do, so there is no second copy to go stale when the config changes underneath.
  const form = useForm({ defaultValues: { name: aliasName } });
  const codes = new Set(issues.map((issue) => issue.code));
  // The duplicate is reported once, at the list level, so the card only points at it. Anything else is
  // this row's own problem and stays in the card.
  const cardIssue = issues.find((issue) => issue.code !== 'alias-name-duplicate');
  const duplicateName = codes.has('alias-name-duplicate');
  const nameFlagged =
    duplicateName ||
    editError === 'name-duplicate' ||
    editError === 'name-required' ||
    codes.has('alias-name-required') ||
    codes.has('preserved-route-conflict');
  const errorMessage =
    editError === null
      ? cardIssue === undefined
        ? null
        : aliasIssueMessage(cardIssue)
      : aliasEditErrorMessage(editError);
  const targetInvalid = editError === 'target-required' || codes.has('target-missing');
  const nameId = aliasControlId(aliasName);

  return (
    <>
      <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
        <form.Field name="name">
          {(field) => (
            <Input
              id={nameId}
              value={field.state.value}
              aria-label={m['dashboard.providers.form.alias_name']()}
              // Unnamed is incomplete, whoever is looking: the row reports it before any save attempt.
              aria-invalid={field.state.value.trim() === '' || nameFlagged}
              aria-describedby={duplicateName ? 'alias-name-duplicate-error' : undefined}
              placeholder={m['dashboard.providers.form.alias_name_placeholder']()}
              className="font-mono text-sm"
              onChange={(event) => {
                field.handleChange(event.target.value);
                // Renaming per keystroke keeps the config and the box in step; the row survives it
                // because its React key is the list's stable id, not this name.
                const result = onRename(event.target.value);
                setEditError(result.ok || result.code === 'alias-missing' ? null : result.code);
              }}
            />
          )}
        </form.Field>
        <ArrowRightIcon className="mx-auto size-4 text-muted-foreground" aria-hidden="true" />
        <Select
          value={config.model}
          onValueChange={(model) => {
            if (model === null) return;
            setEditError(null);
            onAliasChange({ ...alias, [aliasName]: { ...config, model } });
          }}
        >
          <SelectTrigger
            id={`${nameId}-target`}
            className="w-full font-mono"
            aria-label={m['dashboard.providers.form.alias_target']()}
            aria-invalid={targetInvalid}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={m['dashboard.providers.form.remove_alias_named']({ alias: aliasName })}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      {errorMessage !== null && <FieldError>{errorMessage}</FieldError>}
    </>
  );
};
