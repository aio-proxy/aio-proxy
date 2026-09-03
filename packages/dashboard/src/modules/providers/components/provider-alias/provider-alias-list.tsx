import { m } from '@aio-proxy/i18n';
import type { FC } from 'react';

import type { AliasEditorIssue, AliasRow } from '../../lib/alias-editor';
import { ProviderAliasCard } from './provider-alias-card';

interface ProviderAliasListProps {
  readonly alias: readonly AliasRow[];
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly onAliasChange: (alias: readonly AliasRow[]) => void;
  readonly onRenameAlias: (id: string, name: string) => void;
  readonly onRemoveAlias: (id: string) => void;
  readonly onHideAlias?: ((id: string) => void) | undefined;
  readonly onRestoreAlias?: ((id: string) => void) | undefined;
  readonly pluginDefaultNames?: ReadonlySet<string> | undefined;
}

export const ProviderAliasList: FC<ProviderAliasListProps> = ({
  alias,
  models,
  issues,
  onAliasChange,
  onRenameAlias,
  onRemoveAlias,
  onHideAlias,
  onRestoreAlias,
  pluginDefaultNames,
}) => {
  if (alias.length === 0) {
    return (
      <p className="rounded-xl bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
        {m['dashboard.providers.form.aliases_empty']()}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {alias.map((row) => (
        <ProviderAliasCard
          key={row.id}
          alias={alias}
          row={row}
          models={models}
          issues={issues.filter((issue) => issue.alias === row.id)}
          onAliasChange={onAliasChange}
          onRename={(name) => onRenameAlias(row.id, name)}
          onRemove={() => onRemoveAlias(row.id)}
          onHide={onHideAlias === undefined || row.origin === 'hidden' ? undefined : () => onHideAlias(row.id)}
          onRestore={
            onRestoreAlias === undefined ||
            row.origin === 'inherited' ||
            (row.origin === 'authored' && pluginDefaultNames !== undefined && !pluginDefaultNames.has(row.name))
              ? undefined
              : () => onRestoreAlias(row.id)
          }
        />
      ))}
    </div>
  );
};
