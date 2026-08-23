import type { FC } from 'react';

import type { AliasEditorIssue, AliasRow } from '../../lib/alias-editor';
import { ProviderAliasConfigFields } from './provider-alias-config-fields';
import { ProviderAliasVariants } from './provider-alias-variants';

interface ProviderAliasCardProps {
  readonly alias: readonly AliasRow[];
  readonly row: AliasRow;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly onAliasChange: (alias: readonly AliasRow[]) => void;
  readonly onRename: (name: string) => void;
  readonly onRemove: () => void;
}

export const ProviderAliasCard: FC<ProviderAliasCardProps> = ({
  alias,
  row,
  models,
  issues,
  onAliasChange,
  onRename,
  onRemove,
}) => (
  // No header: the name and the target are editable in the row below, and a read-only copy of both
  // above it doubled every card's height for nothing.
  <div className="space-y-3 rounded-2xl border bg-card p-3" data-testid="provider-alias-card">
    <ProviderAliasConfigFields
      alias={alias}
      row={row}
      models={models}
      issues={issues.filter((issue) => issue.variant === undefined)}
      onAliasChange={onAliasChange}
      onRename={onRename}
      onRemove={onRemove}
    />
    <ProviderAliasVariants
      alias={alias}
      row={row}
      models={models}
      issues={issues.filter((issue) => issue.variant !== undefined)}
      onAliasChange={onAliasChange}
    />
  </div>
);
