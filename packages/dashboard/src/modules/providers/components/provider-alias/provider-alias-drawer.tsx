import { m } from "@aio-proxy/i18n";
import { normalizeAliasName } from "@aio-proxy/types";
import { omit } from "es-toolkit/object";
import { PlusIcon } from "lucide-react";
import { type FC, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useIsMobile } from "@/hooks/use-mobile";

import {
  type AliasDraft,
  type AliasEditorIssue,
  type AliasEditResult,
  aliasSummary,
  commitAliasDraft,
  type ProviderAlias,
  renameAlias,
} from "../../alias-editor";
import { aliasSummaryMessage } from "../../alias-editor-copy";
import { ProviderAliasList } from "./provider-alias-list";

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
  const draftSequence = useRef(0);
  const [aliasDraftIds, setAliasDraftIds] = useState<readonly string[]>([]);
  const [variantDrafts, setVariantDrafts] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [dirtyDraftIds, setDirtyDraftIds] = useState<ReadonlySet<string>>(() => new Set());
  const [aliasIds, setAliasIds] = useState<Readonly<Record<string, string>>>({});
  const [discardOpen, setDiscardOpen] = useState(false);
  const summary = aliasSummary(alias);
  const nextDraftId = (kind: "alias" | "variant") => `${kind}-draft-${++draftSequence.current}`;
  const addAliasDraft = () => setAliasDraftIds((current) => [...current, nextDraftId("alias")]);
  const clearDrafts = () => {
    setAliasDraftIds([]);
    setVariantDrafts({});
    setDirtyDraftIds(new Set());
  };
  const close = () => {
    clearDrafts();
    onOpenChange(false);
  };
  const requestOpenChange = (nextOpen: boolean) => {
    if (nextOpen) onOpenChange(true);
    else if (dirtyDraftIds.size > 0) setDiscardOpen(true);
    else close();
  };
  const reportDraftDirty = (id: string, dirty: boolean) =>
    setDirtyDraftIds((current) => {
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  const discardDraft = (id: string) => {
    setAliasDraftIds((current) => current.filter((draftId) => draftId !== id));
    setVariantDrafts((current) =>
      Object.fromEntries(Object.entries(current).map(([name, ids]) => [name, ids.filter((draftId) => draftId !== id)])),
    );
    reportDraftDirty(id, false);
  };
  const removeAlias = (aliasName: string) => {
    const removedDrafts = variantDrafts[aliasName] ?? [];
    onAliasChange(omit(alias, [aliasName]));
    setAliasIds((current) => omit(current, [aliasName]));
    setVariantDrafts((current) => omit(current, [aliasName]));
    setDirtyDraftIds((current) => {
      const next = new Set(current);
      for (const id of removedDrafts) next.delete(id);
      return next;
    });
  };
  const rename = (aliasName: string, name: string): AliasEditResult => {
    const result = renameAlias(alias, aliasName, name);
    if (result.ok) {
      const nextName = normalizeAliasName(name);
      onAliasChange(result.alias);
      setAliasIds((current) => ({
        ...omit(current, [aliasName]),
        [nextName]: current[aliasName] ?? aliasName,
      }));
      setVariantDrafts((current) => ({
        ...omit(current, [aliasName]),
        ...(current[aliasName] === undefined ? {} : { [nextName]: current[aliasName] }),
      }));
    }
    return result;
  };
  const commitDraft = (id: string, draft: AliasDraft): AliasEditResult => {
    const result = commitAliasDraft(alias, draft);
    if (result.ok) {
      onAliasChange(result.alias);
      setAliasIds((current) => ({ ...current, [normalizeAliasName(draft.name)]: id }));
      discardDraft(id);
    }
    return result;
  };

  return (
    <>
      <Drawer open={open} onOpenChange={requestOpenChange} swipeDirection={isMobile ? "down" : "right"}>
        <DrawerContent className="p-0 sm:w-full sm:max-w-[680px]" data-testid="provider-alias-drawer">
          <DrawerHeader className="pb-3">
            <DrawerTitle>{m["dashboard.providers.form.label_aliases"]()}</DrawerTitle>
            <DrawerDescription>{m["dashboard.providers.form.aliases_drawer_description"]()}</DrawerDescription>
            <div className="flex flex-wrap gap-2 pt-2">
              <Badge variant="secondary">{aliasSummaryMessage(summary)}</Badge>
              {issues.length > 0 && (
                <Badge variant="destructive">
                  {m["dashboard.providers.form.aliases_summary_errors"]({ errors: issues.length })}
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
                aliasDraftIds={aliasDraftIds}
                aliasIds={aliasIds}
                variantDrafts={variantDrafts}
                onAliasChange={onAliasChange}
                onAddAliasDraft={addAliasDraft}
                onCommitAliasDraft={commitDraft}
                onDiscardDraft={discardDraft}
                onRenameAlias={rename}
                onRemoveAlias={removeAlias}
                onAddVariantDraft={(aliasName) =>
                  setVariantDrafts((current) => ({
                    ...current,
                    [aliasName]: [...(current[aliasName] ?? []), nextDraftId("variant")],
                  }))
                }
                onDraftDirtyChange={reportDraftDirty}
              />
            </div>
          </ScrollArea>
          <DrawerFooter className="flex-row justify-between border-t pt-4">
            <Button type="button" variant="outline" disabled={models.length === 0} onClick={addAliasDraft}>
              <PlusIcon data-icon="inline-start" />
              {m["dashboard.providers.form.add_alias"]()}
            </Button>
            <Button type="button" onClick={() => requestOpenChange(false)}>
              {m["dashboard.providers.form.aliases_done"]()}
            </Button>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{m["dashboard.providers.form.discard_dialog_title"]()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m["dashboard.providers.form.discard_dialog_description"]()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{m["dashboard.providers.form.discard_dialog_cancel"]()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setDiscardOpen(false);
                close();
              }}
            >
              {m["dashboard.providers.form.discard_dialog_confirm"]()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
