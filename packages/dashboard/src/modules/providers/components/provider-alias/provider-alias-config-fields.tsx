import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { FieldError } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { ArrowRightIcon, EyeOffIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import type { FC } from 'react';

import { type AliasEditorIssue, type AliasRow, aliasControlId } from '../../lib/alias-editor';
import { aliasIssueMessage } from '../../lib/alias-editor-copy';

interface ProviderAliasConfigFieldsProps {
  readonly alias: readonly AliasRow[];
  readonly row: AliasRow;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly onAliasChange: (alias: readonly AliasRow[]) => void;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
  readonly onHide?: (() => void) | undefined;
  readonly onRestore?: (() => void) | undefined;
}

export const ProviderAliasConfigFields: FC<ProviderAliasConfigFieldsProps> = ({
  alias,
  row,
  models,
  issues,
  onAliasChange,
  onRename,
  onRemove,
  onHide,
  onRestore,
}) => {
  const codes = new Set(issues.map((issue) => issue.code));
  // The duplicate is reported once, at the list level, so the card only points at it. Anything else is
  // this row's own problem and stays in the card.
  const cardIssue = issues.find((issue) => issue.code !== 'alias-name-duplicate');
  const duplicateName = codes.has('alias-name-duplicate');
  const nameFlagged = duplicateName || codes.has('alias-name-required') || codes.has('preserved-route-conflict');
  const errorMessage = cardIssue === undefined ? null : aliasIssueMessage(cardIssue);
  const targetInvalid = codes.has('target-missing');
  const nameId = aliasControlId(row.id);

  return (
    <>
      <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
        <Input
          id={nameId}
          value={row.name}
          aria-label={m['dashboard.providers.form.alias_name']()}
          // Unnamed is incomplete, whoever is looking: the row reports it before any save attempt.
          aria-invalid={row.name.trim() === '' || nameFlagged}
          aria-describedby={duplicateName ? 'alias-name-duplicate-error' : undefined}
          placeholder={m['dashboard.providers.form.alias_name_placeholder']()}
          className="font-mono text-sm"
          disabled={row.origin === 'inherited' || row.origin === 'hidden'}
          onChange={(event) => onRename(event.target.value)}
        />
        <ArrowRightIcon className="mx-auto size-4 text-muted-foreground" aria-hidden="true" />
        <Select
          value={row.config.model}
          disabled={row.origin === 'hidden'}
          onValueChange={(model) => {
            if (model === null) return;
            onAliasChange(
              alias.map((item) =>
                item.id === row.id
                  ? {
                      ...item,
                      origin: item.origin === 'inherited' ? 'authored' : item.origin,
                      config: { ...item.config, model },
                    }
                  : item,
              ),
            );
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
        {onHide === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={m['dashboard.providers.form.hide_inherited_alias']({ alias: row.name })}
            onClick={onHide}
          >
            <EyeOffIcon />
          </Button>
        )}
        {onRestore === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={m['dashboard.providers.form.restore_plugin_alias']({ alias: row.name })}
            onClick={onRestore}
          >
            <RotateCcwIcon />
          </Button>
        )}
        {row.origin === 'inherited' || row.origin === 'hidden' ? null : (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={m['dashboard.providers.form.remove_alias_named']({ alias: row.name })}
            onClick={onRemove}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>
      {errorMessage !== null && <FieldError>{errorMessage}</FieldError>}
    </>
  );
};
