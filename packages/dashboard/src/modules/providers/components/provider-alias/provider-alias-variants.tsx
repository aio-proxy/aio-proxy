import { m } from '@aio-proxy/i18n';
import type { AliasConfig } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Switch } from '@aio-proxy/ui/components/switch';
import { PlusIcon } from 'lucide-react';
import type { FC } from 'react';

import {
  addVariantRow,
  type AliasEditorIssue,
  blankVariantRow,
  type ProviderAlias,
  variantRows,
  withVariantRows,
} from '../../lib/alias-editor';
import { aliasIssueMessage } from '../../lib/alias-editor-copy';
import { ProviderVariantRow } from '../provider-variant-row';
import { useVariantRowKeys } from './use-variant-row-keys';

interface ProviderAliasVariantsProps {
  readonly alias: ProviderAlias;
  readonly aliasName: string;
  readonly config: AliasConfig;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly onAliasChange: (alias: ProviderAlias) => void;
}

export const ProviderAliasVariants: FC<ProviderAliasVariantsProps> = ({
  alias,
  aliasName,
  config,
  models,
  issues,
  onAliasChange,
}) => {
  const rows = variantRows(config);
  const { keys, appendKey, dropKey } = useVariantRowKeys(rows.length);
  // Two rows can fail the same way; the list names each problem once, and `aria-invalid` on the
  // offending controls is what points at which row it came from.
  const messages = [...new Set(issues.map(aliasIssueMessage))];

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
        {/* The alias-level preserve switch shares this row with the add button: one divider, two blocks
            per card. It reads the stored config, like the switch on every variant row. */}
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            size="sm"
            checked={config.preserve}
            onCheckedChange={(preserve) =>
              onAliasChange({ ...alias, [aliasName]: { ...config, preserve: Boolean(preserve) } })
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
            onAliasChange(addVariantRow(alias, aliasName, blankVariantRow(config.model)));
          }}
        >
          <PlusIcon data-icon="inline-start" />
          {m['dashboard.providers.form.add_variant']()}
        </Button>
      </div>
      {rows.length > 0 && (
        <div className="space-y-2 rounded-xl bg-muted/40 p-2.5">
          {rows.map((row, index) => (
            <ProviderVariantRow
              key={keys[index] ?? index}
              aliasName={aliasName}
              index={index}
              row={row}
              models={models}
              issues={issues.filter((issue) => issue.variant === index)}
              onChange={(next) =>
                onAliasChange(
                  withVariantRows(
                    alias,
                    aliasName,
                    rows.map((current, position) => (position === index ? next : current)),
                  ),
                )
              }
              onRemove={() => {
                dropKey(index);
                onAliasChange(
                  withVariantRows(
                    alias,
                    aliasName,
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
