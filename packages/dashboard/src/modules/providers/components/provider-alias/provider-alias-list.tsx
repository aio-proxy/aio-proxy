import { m } from '@aio-proxy/i18n';
import type { FC } from 'react';

import type { AliasEditorIssue, AliasEditResult, ProviderAlias } from '../../lib/alias-editor';
import { ProviderAliasCard } from './provider-alias-card';

interface ProviderAliasListProps {
  readonly alias: ProviderAlias;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly rowKey: (aliasName: string) => string;
  readonly onAliasChange: (alias: ProviderAlias) => void;
  readonly onRenameAlias: (alias: string, name: string) => AliasEditResult;
  readonly onRemoveAlias: (alias: string) => void;
}

export const ProviderAliasList: FC<ProviderAliasListProps> = ({
  alias,
  models,
  issues,
  rowKey,
  onAliasChange,
  onRenameAlias,
  onRemoveAlias,
}) => {
  if (Object.keys(alias).length === 0) {
    return (
      <p className="rounded-xl bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
        {m['dashboard.providers.form.aliases_empty']()}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {Object.entries(alias).map(([aliasName, config]) => (
        <ProviderAliasCard
          key={rowKey(aliasName)}
          alias={alias}
          aliasName={aliasName}
          config={config}
          models={models}
          issues={issues.filter((issue) => issue.alias === aliasName)}
          onAliasChange={onAliasChange}
          onRename={(name) => onRenameAlias(aliasName, name)}
          onRemove={() => onRemoveAlias(aliasName)}
        />
      ))}
    </div>
  );
};
