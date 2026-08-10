import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from '@aio-proxy/ui/components/combobox';
import type React from 'react';

import { splitByTokenSeparators, type TagsInputItem, useTagsInput } from './use-tags-input';

interface TagsInputProps {
  readonly value: readonly string[];
  readonly onValueChange: (next: string[]) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly id?: string;
  readonly removeLabel: (tag: string) => string;
  readonly tokenSeparators?: readonly string[];
  readonly options?: readonly string[];
  readonly showValues?: boolean;
}

export const TagsInput: React.FC<TagsInputProps> = ({
  value,
  onValueChange,
  placeholder,
  disabled,
  id,
  removeLabel,
  tokenSeparators = [',', '\n'],
  options = [],
  showValues = true,
}) => {
  const { draft, setDraft, open, setOpen, anchor, highlightedItemRef, items, selectedItems, addMany, commit } =
    useTagsInput({ value, onValueChange, options });

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
        const created = nextItems.find((item) => 'isNew' in item && item.isNew);
        if (created !== undefined) {
          addMany([created.value]);
          return;
        }
        onValueChange(nextItems.map((item) => item.value));
        setDraft('');
      }}
    >
      <ComboboxChips ref={anchor}>
        <ComboboxValue>
          {showValues
            ? value.map((tag) => (
                <ComboboxChip key={tag} removeLabel={removeLabel(tag)}>
                  {tag}
                </ComboboxChip>
              ))
            : null}
        </ComboboxValue>
        <ComboboxChipsInput
          id={id}
          disabled={disabled}
          placeholder={!showValues || value.length === 0 ? placeholder : undefined}
          onBlur={() => commit()}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            if (open) setOpen(false);
            else setDraft('');
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && highlightedItemRef.current === null) {
              event.preventDefault();
              commit();
            } else if (tokenSeparators.includes(event.key)) {
              event.preventDefault();
              commit(highlightedItemRef.current);
            }
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData('text');
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
              <ComboboxItem key={`${item.isNew ? 'new:' : ''}${item.value}`} value={item}>
                {item.value}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      )}
    </Combobox>
  );
};
