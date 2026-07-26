import { m } from '@aio-proxy/i18n';
import { PlusIcon } from 'lucide-react';
import type { FC } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIsMobile } from '@/hooks/use-mobile';

import { type AliasEditorIssue, aliasSummary, type ProviderAlias } from '../../alias-editor';
import { aliasSummaryMessage } from '../../alias-editor-copy';
import { ProviderAliasList } from './provider-alias-list';
import { useAliasDrafts } from './use-alias-drafts';

type Props = {
  readonly alias: ProviderAlias;
  readonly models: readonly string[];
  readonly issues: readonly AliasEditorIssue[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAliasChange: (alias: ProviderAlias) => void;
};

export const ProviderAliasDrawer: FC<Props> = ({ alias, models, issues, open, onOpenChange, onAliasChange }) => {
  const isMobile = useIsMobile();
  const drafts = useAliasDrafts(alias, onAliasChange);
  const summary = aliasSummary(alias);
  const close = () => {
    drafts.clearDrafts();
    onOpenChange(false);
  };
  const requestOpenChange = (nextOpen: boolean) => {
    if (nextOpen) onOpenChange(true);
    else if (drafts.hasDirtyDrafts) drafts.setDiscardOpen(true);
    else close();
  };

  return (
    <>
      <Drawer open={open} onOpenChange={requestOpenChange} swipeDirection={isMobile ? 'down' : 'right'}>
        <DrawerContent className="p-0 sm:w-full sm:max-w-[680px]" data-testid="provider-alias-drawer">
          <DrawerHeader className="pb-3">
            <DrawerTitle>{m['dashboard.providers.form.label_aliases']()}</DrawerTitle>
            <DrawerDescription>{m['dashboard.providers.form.aliases_drawer_description']()}</DrawerDescription>
            <div className="flex flex-wrap gap-2 pt-2">
              <Badge variant="secondary">{aliasSummaryMessage(summary)}</Badge>
              {issues.length > 0 && (
                <Badge variant="destructive">
                  {m['dashboard.providers.form.aliases_summary_errors']({ errors: issues.length })}
                </Badge>
              )}
            </div>
          </DrawerHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-6 pt-0">
              <ProviderAliasList
                alias={alias}
                models={models}
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
            </div>
          </ScrollArea>
          <DrawerFooter className="flex-row justify-between border-t pt-4">
            <Button type="button" variant="outline" disabled={models.length === 0} onClick={drafts.addAliasDraft}>
              <PlusIcon data-icon="inline-start" />
              {m['dashboard.providers.form.add_alias']()}
            </Button>
            <Button type="button" onClick={() => requestOpenChange(false)}>
              {m['dashboard.providers.form.aliases_done']()}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
      <AlertDialog open={drafts.discardOpen} onOpenChange={drafts.setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m['dashboard.providers.form.discard_dialog_title']()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m['dashboard.providers.form.discard_dialog_description']()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m['dashboard.providers.form.discard_dialog_cancel']()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                drafts.setDiscardOpen(false);
                close();
              }}
            >
              {m['dashboard.providers.form.discard_dialog_confirm']()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
