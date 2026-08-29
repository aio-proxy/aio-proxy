import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Switch } from '@aio-proxy/ui/components/switch';
import { uniq } from 'es-toolkit/array';
import { PlusIcon } from 'lucide-react';
import type { FC } from 'react';

import {
  addVariantRow,
  type AliasEditorIssue,
  type AliasRow,
  blankVariantRow,
  variantRows,
  withVariantRows,
} from '../../lib/alias-editor';
import { aliasIssueMessage } from '../../lib/alias-editor-copy';
import { ProviderVariantRow } from '../provider-variant-row';
import { useVariantRowKeys } from './use-variant-row-keys';

interface ProviderAliasVariantsProps {
  readonly alias: readonly AliasRow[];
  readonly row: AliasRow;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly onAliasChange: (alias: readonly AliasRow[]) => void;
}

export const ProviderAliasVariants: FC<ProviderAliasVariantsProps> = ({
  alias,
  row,
  models,
  issues,
  onAliasChange,
}) => {
  const rows = variantRows(row.config);
  const { keys, appendKey, dropKey } = useVariantRowKeys(rows.length);
  // Two rows can fail the same way; the list names each problem once, and `aria-invalid` on the
  // offending controls is what points at which row it came from.
  const messages = uniq(issues.map(aliasIssueMessage));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        {/* The alias-level preserve switch shares this row with the add button: one divider, two blocks
            per card. It reads the stored config, like the switch on every variant row. */}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={row.config.preserve}
            onCheckedChange={(preserve) =>
              onAliasChange(
                alias.map((item) =>
                  item.id === row.id ? { ...item, config: { ...item.config, preserve: Boolean(preserve) } } : item,
                ),
              )
            }
          />
          {m['dashboard.providers.form.alias_preserve']()}
        </label>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => {
            appendKey();
            // A new condition starts on the alias's own target, which is what the user meant most of
            // the time; the first enabled model was a coin flip they had to correct.
            onAliasChange(addVariantRow(alias, row.id, blankVariantRow(row.config.model)));
          }}
        >
          <PlusIcon data-icon="inline-start" />
          {m['dashboard.providers.form.add_variant']()}
        </Button>
      </div>
      {rows.length > 0 && (
        <div className="space-y-2 rounded-xl bg-muted/40 p-2.5">
          {rows.map((variant, index) => (
            <ProviderVariantRow
              key={keys[index] ?? index}
              rowId={row.id}
              aliasName={row.name}
              index={index}
              row={variant}
              models={models}
              issues={issues.filter((issue) => issue.variant === index)}
              onChange={(next) =>
                onAliasChange(
                  withVariantRows(
                    alias,
                    row.id,
                    rows.map((current, position) => (position === index ? next : current)),
                  ),
                )
              }
              onRemove={() => {
                dropKey(index);
                onAliasChange(
                  withVariantRows(
                    alias,
                    row.id,
                    rows.filter((_, position) => position !== index),
                  ),
                );
              }}
            />
          ))}
        </div>
      )}
      {messages.length > 0 && (
        <ul role="alert" className="space-y-1 text-xs text-destructive">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </>
  );
};
