import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { PlusIcon } from 'lucide-react';

import type { AliasEditorIssue, ProviderAlias } from '../../../lib/alias-editor';
import { ProviderAliasList, useAliasDrafts } from '../../provider-alias';

interface RoutingAliasesProps {
  readonly alias: ProviderAlias;
  readonly issues: readonly AliasEditorIssue[];
  /** The whitelist, or the discovered catalog when the whitelist is empty. */
  readonly targetOptions: readonly string[];
  readonly onAliasChange: (alias: ProviderAlias) => void;
}

/**
 * The draft layer did not die with the alias drawer: a not-yet-named alias cannot be a key in the
 * `alias` record, and renaming has to reject duplicates. What went away is staging-until-close — rows
 * write the form as soon as an alias has a name.
 */
export const RoutingAliases: React.FC<RoutingAliasesProps> = ({ alias, issues, targetOptions, onAliasChange }) => {
  const drafts = useAliasDrafts(alias, onAliasChange);
  // The list renders its own add button in the empty state, so only offer one once rows exist.
  const hasRows = Object.keys(alias).length > 0 || drafts.aliasDraftIds.length > 0;

  return (
    <div className="flex flex-col gap-4" data-testid="provider-editor-field-alias">
      <div>
        <h3 className="text-sm font-medium">{m['dashboard.providers.editor.aliases_heading']()}</h3>
        <p className="max-w-2xl text-xs text-muted-foreground">
          {m['dashboard.providers.editor.aliases_description']()}
        </p>
      </div>
      <ProviderAliasList
        alias={alias}
        models={targetOptions}
        issues={issues}
        aliasDraftIds={drafts.aliasDraftIds}
        aliasIds={drafts.aliasIds}
        variantDrafts={drafts.variantDrafts}
        onAliasChange={onAliasChange}
        onAddAliasDraft={drafts.addAliasDraft}
        onCommitAliasDraft={drafts.commitDraft}
        onDiscardDraft={drafts.discardDraft}
        onRenameAlias={drafts.rename}
        onRemoveAlias={drafts.removeAlias}
        onAddVariantDraft={drafts.addVariantDraft}
        onDraftDirtyChange={drafts.reportDraftDirty}
      />
      {hasRows ? (
        <Button
          type="button"
          variant="outline"
          className="self-start"
          // Gated on the resolved options, not the whitelist: an alias-only provider must stay
          // authorable, but a picker with zero options cannot produce a valid alias.
          disabled={targetOptions.length === 0}
          onClick={drafts.addAliasDraft}
        >
          <PlusIcon data-icon="inline-start" />
          {m['dashboard.providers.form.add_alias']()}
        </Button>
      ) : null}
    </div>
  );
};
