import { useMemo, useRef, useState } from 'react';

import { useComboboxAnchor } from '@/components/ui/combobox';

export interface TagsInputItem {
  readonly value: string;
  readonly isNew?: true;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const splitByTokenSeparators = (value: string, tokenSeparators: readonly string[]) => {
  const separators = tokenSeparators.filter((separator) => separator !== '');
  if (!separators.some((separator) => value.includes(separator))) return;
  return value.split(new RegExp(separators.map(escapeRegExp).join('|')));
};

interface UseTagsInputOptions {
  readonly value: readonly string[];
  readonly onValueChange: (next: string[]) => void;
  readonly options: readonly string[];
}

export const useTagsInput = ({ value, onValueChange, options }: UseTagsInputOptions) => {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const anchor = useComboboxAnchor();
  const highlightedItemRef = useRef<TagsInputItem | null>(null);
  const trimmedDraft = draft.trim();

  const baseItems = useMemo(
    () => [...new Set([...options, ...value])].map((item) => ({ value: item })),
    [options, value],
  );
  const items = useMemo(
    () =>
      options.length > 0 && trimmedDraft !== '' && !baseItems.some((item) => item.value === trimmedDraft)
        ? [...baseItems, { value: trimmedDraft, isNew: true as const }]
        : baseItems,
    [baseItems, options.length, trimmedDraft],
  );
  const itemByValue = useMemo(() => new Map(items.map((item) => [item.value, item])), [items]);
  const selectedItems = value.flatMap((item) => {
    const selected = itemByValue.get(item);
    return selected === undefined ? [] : [selected];
  });

  const addMany = (parts: readonly string[]) => {
    const next = [...value];
    for (const raw of parts) {
      const tag = raw.trim();
      if (tag !== '' && !next.includes(tag)) next.push(tag);
    }
    if (next.length !== value.length) onValueChange(next);
    setDraft('');
  };

  const commit = (item: TagsInputItem | null = null) => {
    if (item !== null && !item.isNew) {
      addMany([item.value]);
      return;
    }
    addMany([item?.value ?? draft]);
  };

  return { draft, setDraft, open, setOpen, anchor, highlightedItemRef, items, selectedItems, addMany, commit };
};
