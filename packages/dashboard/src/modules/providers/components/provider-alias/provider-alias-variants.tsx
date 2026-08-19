import { m } from '@aio-proxy/i18n';
import type { AliasConfig } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
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
  // Two rows can fail the same way; the list names each problem once, and `aria-invalid` on the
  // offending controls is what points at which row it came from.
  const messages = [...new Set(issues.map(aliasIssueMessage))];

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-3">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={models.length === 0}
          onClick={() => onAliasChange(addVariantRow(alias, aliasName, blankVariantRow(models[0] ?? '')))}
        >
          <PlusIcon data-icon="inline-start" />
          {m['dashboard.providers.form.add_variant']()}
        </Button>
      </div>
      {rows.length > 0 && (
        <div className="space-y-2 rounded-xl bg-muted/40 p-2.5">
          {rows.map((row, index) => (
            <ProviderVariantRow
              key={index}
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
              onRemove={() =>
                onAliasChange(
                  withVariantRows(
                    alias,
                    aliasName,
                    rows.filter((_, position) => position !== index),
                  ),
                )
              }
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
