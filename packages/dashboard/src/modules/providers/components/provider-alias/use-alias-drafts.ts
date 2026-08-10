import { normalizeAliasName } from '@aio-proxy/types';
import { omit } from 'es-toolkit/object';
import { useRef, useState } from 'react';

import {
  type AliasDraft,
  type AliasEditResult,
  commitAliasDraft,
  type ProviderAlias,
  renameAlias,
} from '../../lib/alias-editor';

export const useAliasDrafts = (alias: ProviderAlias, onAliasChange: (alias: ProviderAlias) => void) => {
  const draftSequence = useRef(0);
  const [aliasDraftIds, setAliasDraftIds] = useState<readonly string[]>([]);
  const [variantDrafts, setVariantDrafts] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [dirtyDraftIds, setDirtyDraftIds] = useState<ReadonlySet<string>>(() => new Set());
  const [aliasIds, setAliasIds] = useState<Readonly<Record<string, string>>>({});
  const [discardOpen, setDiscardOpen] = useState(false);

  const nextDraftId = (kind: 'alias' | 'variant') => `${kind}-draft-${++draftSequence.current}`;
  const addAliasDraft = () => setAliasDraftIds((current) => [...current, nextDraftId('alias')]);
  const addVariantDraft = (aliasName: string) =>
    setVariantDrafts((current) => ({
      ...current,
      [aliasName]: [...(current[aliasName] ?? []), nextDraftId('variant')],
    }));
  const clearDrafts = () => {
    setAliasDraftIds([]);
    setVariantDrafts({});
    setDirtyDraftIds(new Set());
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

  return {
    aliasDraftIds,
    variantDrafts,
    aliasIds,
    hasDirtyDrafts: dirtyDraftIds.size > 0,
    discardOpen,
    setDiscardOpen,
    clearDrafts,
    addAliasDraft,
    addVariantDraft,
    reportDraftDirty,
    discardDraft,
    removeAlias,
    rename,
    commitDraft,
  };
};
