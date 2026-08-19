import { m } from '@aio-proxy/i18n';
import type { FC } from 'react';

import type { AliasDraft, AliasEditorIssue, AliasEditResult, ProviderAlias } from '../../lib/alias-editor';
import { ProviderAliasCard } from './provider-alias-card';
import { ProviderAliasDraft } from './provider-alias-draft';

interface ProviderAliasListProps {
  readonly alias: ProviderAlias;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly aliasDraftIds: readonly string[];
  readonly aliasIds: Readonly<Record<string, string>>;
  readonly onAliasChange: (alias: ProviderAlias) => void;
  readonly onCommitAliasDraft: (id: string, draft: AliasDraft) => AliasEditResult;
  readonly onDiscardDraft: (id: string) => void;
  readonly onRenameAlias: (alias: string, name: string) => AliasEditResult;
  readonly onRemoveAlias: (alias: string) => void;
  readonly onDraftDirtyChange: (id: string, dirty: boolean) => void;
}

export const ProviderAliasList: FC<ProviderAliasListProps> = ({
  alias,
  models,
  issues,
  aliasDraftIds,
  aliasIds,
  onAliasChange,
  onCommitAliasDraft,
  onDiscardDraft,
  onRenameAlias,
  onRemoveAlias,
  onDraftDirtyChange,
}) => {
  if (Object.keys(alias).length === 0 && aliasDraftIds.length === 0) {
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
          key={aliasIds[aliasName] ?? aliasName}
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
      {aliasDraftIds.map((id) => (
        <ProviderAliasDraft
          key={id}
          id={id}
          models={models}
          onDirtyChange={onDraftDirtyChange}
          onDiscard={() => onDiscardDraft(id)}
          onCommit={(draft) => onCommitAliasDraft(id, draft)}
        />
      ))}
    </div>
  );
};
