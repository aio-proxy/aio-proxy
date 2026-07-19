import type React from "react";

import { useMemo, useRef, useState } from "react";

import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "@/components/ui/combobox";

interface TagsInputProps {
  readonly value: readonly string[];
  readonly onValueChange: (next: string[]) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly removeLabel: (tag: string) => string;
  readonly tokenSeparators?: readonly string[];
  readonly options?: readonly string[];
}

interface TagsInputItem {
  readonly value: string;
  readonly isNew?: true;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const splitByTokenSeparators = (value: string, tokenSeparators: readonly string[]) => {
  const separators = tokenSeparators.filter((separator) => separator !== "");
  if (!separators.some((separator) => value.includes(separator))) return;
  return value.split(new RegExp(separators.map(escapeRegExp).join("|")));
};

export const TagsInput: React.FC<TagsInputProps> = ({
  value,
  onValueChange,
  placeholder,
  disabled,
  id,
  removeLabel,
  tokenSeparators = [",", "\n"],
  options = [],
}) => {
  const [draft, setDraft] = useState("");
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
      options.length > 0 && trimmedDraft !== "" && !baseItems.some((item) => item.value === trimmedDraft)
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
      if (tag !== "" && !next.includes(tag)) next.push(tag);
    }
    if (next.length !== value.length) onValueChange(next);
    setDraft("");
  };

  const commit = (item: TagsInputItem | null = null) => {
    if (item !== null && !item.isNew) {
      addMany([item.value]);
      return;
    }
    addMany([item?.value ?? draft]);
  };

  return (
    <Combobox
      items={items}
      itemToStringLabel={(item) => item.value}
      isItemEqualToValue={(item, selected) => item.value === selected.value}
      multiple
      disabled={disabled}
      value={selectedItems}
      inputValue={draft}
      onInputValueChange={setDraft}
      open={options.length > 0 && open}
      onOpenChange={(nextOpen) => setOpen(options.length > 0 && nextOpen)}
      onItemHighlighted={(item) => {
        highlightedItemRef.current = item ?? null;
      }}
      onValueChange={(nextItems) => {
        const created = nextItems.find((item) => item.isNew);
        if (created !== undefined) {
          addMany([created.value]);
          return;
        }
        onValueChange(nextItems.map((item) => item.value));
        setDraft("");
      }}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {value.map((tag) => (
            <ComboboxChip key={tag} removeLabel={removeLabel(tag)}>
              {tag}
            </ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput
          id={id}
          disabled={disabled}
          placeholder={value.length === 0 ? placeholder : undefined}
          onBlur={() => commit()}
          onKeyDownCapture={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            if (open) setOpen(false);
            else setDraft("");
          }}
          onKeyDown={(event) => {
            if (event.which === 229 || event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && highlightedItemRef.current === null) {
              event.preventDefault();
              commit();
            } else if (tokenSeparators.includes(event.key)) {
              event.preventDefault();
              commit(highlightedItemRef.current);
            }
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            const parts = splitByTokenSeparators(text, tokenSeparators);
            if (parts === undefined) return;
            event.preventDefault();
            addMany(parts);
          }}
        />
      </ComboboxChips>
      {options.length > 0 && (
        <ComboboxContent anchor={anchor}>
          <ComboboxList>
            {(item: TagsInputItem) => (
              <ComboboxItem key={`${item.isNew ? "new:" : ""}${item.value}`} value={item}>
                {item.value}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      )}
    </Combobox>
  );
};
