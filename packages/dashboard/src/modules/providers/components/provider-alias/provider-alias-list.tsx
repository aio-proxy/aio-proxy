import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { PlusIcon, WaypointsIcon } from 'lucide-react';
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
  readonly onAddAliasDraft: () => void;
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
  onAddAliasDraft,
  onCommitAliasDraft,
  onDiscardDraft,
  onRenameAlias,
  onRemoveAlias,
  onDraftDirtyChange,
}) => {
  if (Object.keys(alias).length === 0 && aliasDraftIds.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WaypointsIcon />
          </EmptyMedia>
          <EmptyTitle>{m['dashboard.providers.form.aliases_empty']()}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" disabled={models.length === 0} onClick={onAddAliasDraft}>
            <PlusIcon data-icon="inline-start" />
            {m['dashboard.providers.form.add_alias']()}
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <>
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
    </>
  );
};
