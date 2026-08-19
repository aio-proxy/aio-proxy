import { normalizeAliasName } from '@aio-proxy/types';
import { omit } from 'es-toolkit/object';
import { useRef } from 'react';

import { type AliasEditResult, type ProviderAlias, renameAlias } from '../../lib/alias-editor';

/**
 * A row's identity cannot be its alias name: the name is renamed on every keystroke, so a name-derived
 * React key would remount the row on the first character and take the caret with it.
 */
export const useAliasRows = (alias: ProviderAlias, onAliasChange: (alias: ProviderAlias) => void) => {
  const rowIds = useRef(new Map<string, string>());
  const sequence = useRef(0);

  const rowKey = (aliasName: string): string => {
    const existing = rowIds.current.get(aliasName);
    if (existing !== undefined) return existing;
    const id = `alias-row-${++sequence.current}`;
    rowIds.current.set(aliasName, id);
    return id;
  };

  return {
    rowKey,
    /**
     * The new row is an ordinary alias with no name yet, edited in place. It reports
     * `alias-name-required` until it has one, which is what the demo's red empty box says too.
     *
     * ponytail: an alias record is keyed by name, so it holds one unnamed row at a time — adding a
     * second before naming the first is a no-op. An editor-side array draft is the fix if that bites.
     */
    addAlias: (model: string | undefined) => {
      if (model === undefined) return;
      onAliasChange({ ...alias, '': { model, preserve: false } });
    },
    removeAlias: (aliasName: string) => {
      rowIds.current.delete(aliasName);
      onAliasChange(omit(alias, [aliasName]));
    },
    rename: (aliasName: string, name: string): AliasEditResult => {
      const result = renameAlias(alias, aliasName, name);
      if (result.ok) {
        const id = rowKey(aliasName);
        rowIds.current.delete(aliasName);
        rowIds.current.set(normalizeAliasName(name), id);
        onAliasChange(result.alias);
      }
      return result;
    },
  };
};
