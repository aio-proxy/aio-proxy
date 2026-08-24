import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { ArrowRightIcon, PlusIcon } from 'lucide-react';

import type { AliasEditorIssue, AliasRow } from '../../../lib/alias-editor';
import { ProviderAliasList, useAliasRows } from '../../provider-alias';
import { SyncPluginAliasesAction } from './sync-plugin-aliases-action';

interface ModelAliasesProps {
  readonly alias: readonly AliasRow[];
  readonly issues: readonly AliasEditorIssue[];
  /** Enabled upstream model ids — the only legal alias targets. */
  readonly targetOptions: readonly string[];
  readonly onAliasChange: (alias: readonly AliasRow[]) => void;
  /**
   * Absent whenever there is nothing to sync. The parent owns the decision because filtering the
   * plugin's suggestions needs the draft's own `models` whitelist, and this component only sees
   * `targetOptions`, which falls back to the whole catalog when that whitelist is empty.
   */
  readonly onSyncPluginAliases?: (() => void) | undefined;
}

/**
 * Lives with the models it renames, not with routing: an alias names a client-facing model id and
 * points it at one of the ids picked above, so authoring it anywhere else means scrolling away from
 * the list you are choosing targets from (the user's ruling; fidelity-rules D-F6).
 */
export const ModelAliases: React.FC<ModelAliasesProps> = ({
  alias,
  issues,
  targetOptions,
  onAliasChange,
  onSyncPluginAliases,
}) => {
  const rows = useAliasRows(alias, onAliasChange);
  const hasRows = alias.length > 0;
  const hasDuplicateName = issues.some((issue) => issue.code === 'alias-name-duplicate');

  return (
    // `border-t pt-5` because this block shares the Models section with the row list above it: two
    // headings under one section heading need the rule to read as two blocks, not one long one.
    <div className="space-y-3 border-t pt-5" data-testid="provider-editor-field-alias">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h3 className="text-sm font-medium">{m['dashboard.providers.editor.aliases_heading']()}</h3>
          <p className="text-xs text-muted-foreground">{m['dashboard.providers.editor.aliases_description']()}</p>
        </div>
        {onSyncPluginAliases === undefined ? null : (
          <SyncPluginAliasesAction disabled={targetOptions.length === 0} onClick={onSyncPluginAliases} />
        )}
      </div>
      {hasRows ? (
        <div className="hidden grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 px-3 text-xs text-muted-foreground sm:grid">
          <span>{m['dashboard.providers.editor.alias_column_client']()}</span>
          <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          <span>{m['dashboard.providers.editor.alias_column_upstream']()}</span>
          <span className="w-6" />
        </div>
      ) : null}
      <ProviderAliasList
        alias={alias}
        models={targetOptions}
        issues={issues}
        onAliasChange={onAliasChange}
        onRenameAlias={rows.rename}
        onRemoveAlias={rows.removeAlias}
      />
      {hasDuplicateName ? (
        <p id="alias-name-duplicate-error" role="alert" className="text-xs text-destructive">
          {m['dashboard.providers.form.alias_name_duplicate']()}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={targetOptions.length === 0}
        onClick={() => rows.addAlias(targetOptions[0])}
      >
        <PlusIcon data-icon="inline-start" />
        {m['dashboard.providers.form.add_alias']()}
      </Button>
    </div>
  );
};
