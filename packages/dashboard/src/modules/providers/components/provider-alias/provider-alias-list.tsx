import { m } from "@aio-proxy/i18n";
import { PlusIcon, WaypointsIcon } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import type { AliasDraft, AliasEditorIssue, AliasEditResult, ProviderAlias } from "../../alias-editor";
import { ProviderAliasCard } from "./provider-alias-card";
import { ProviderAliasDraft } from "./provider-alias-draft";

type Props = {
  readonly alias: ProviderAlias;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly aliasDraftIds: readonly string[];
  readonly aliasIds: Readonly<Record<string, string>>;
  readonly variantDrafts: Readonly<Record<string, readonly string[]>>;
  readonly onAliasChange: (alias: ProviderAlias) => void;
  readonly onAddAliasDraft: () => void;
  readonly onCommitAliasDraft: (id: string, draft: AliasDraft) => AliasEditResult;
  readonly onDiscardDraft: (id: string) => void;
  readonly onRenameAlias: (alias: string, name: string) => AliasEditResult;
  readonly onRemoveAlias: (alias: string) => void;
  readonly onAddVariantDraft: (alias: string) => void;
  readonly onDraftDirtyChange: (id: string, dirty: boolean) => void;
};

export const ProviderAliasList: FC<Props> = ({
  alias,
  models,
  issues,
  aliasDraftIds,
  aliasIds,
  variantDrafts,
  onAliasChange,
  onAddAliasDraft,
  onCommitAliasDraft,
  onDiscardDraft,
  onRenameAlias,
  onRemoveAlias,
  onAddVariantDraft,
  onDraftDirtyChange,
}) => {
  if (models.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WaypointsIcon />
          </EmptyMedia>
          <EmptyTitle>{m["dashboard.providers.form.aliases_empty_models"]()}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  if (Object.keys(alias).length === 0 && aliasDraftIds.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <WaypointsIcon />
          </EmptyMedia>
          <EmptyTitle>{m["dashboard.providers.form.aliases_empty"]()}</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" onClick={onAddAliasDraft}>
            <PlusIcon data-icon="inline-start" />
            {m["dashboard.providers.form.add_alias"]()}
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
          variantDraftIds={variantDrafts[aliasName] ?? []}
          onAliasChange={onAliasChange}
          onRename={(name) => onRenameAlias(aliasName, name)}
          onRemove={() => onRemoveAlias(aliasName)}
          onAddVariantDraft={() => onAddVariantDraft(aliasName)}
          onDiscardVariantDraft={onDiscardDraft}
          onDraftDirtyChange={onDraftDirtyChange}
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
