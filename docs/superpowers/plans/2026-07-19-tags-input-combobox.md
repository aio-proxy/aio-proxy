# Tags Input Combobox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the provider model `TagsInput` on the configured shadcn/ui Base Combobox so its styling stays aligned while preserving free-form creation and supporting optional searchable suggestions.

**Architecture:** The shadcn CLI supplies untouched `combobox.tsx` and `input-group.tsx` primitives. The application-level `TagsInput` controls selected string values and draft input, maps them to Base UI Combobox items, and owns only creatable-tag policy such as separators, paste, IME, blur, duplicate handling, and Escape protection.

**Tech Stack:** React 19, shadcn/ui Base UI registry, `@base-ui/react` 1.6, TanStack Form, Rstest, Testing Library, Bun.

## Global Constraints

- Do not modify generated shadcn files after installation.
- Do not overwrite the existing `button.tsx`, `input.tsx`, or `textarea.tsx` files when adding Combobox registry dependencies.
- Keep the controlled provider form value contract as `readonly string[]` to `(next: string[]) => void`.
- Preserve arbitrary values, trimming, exact duplicate prevention, insertion order, Enter/comma/blur creation, comma/newline paste, localized removal labels, disabled behavior, and IME safety.
- Render dropdown content only when `options` is non-empty; no model suggestion source is added in this change.
- Do not copy border, radius, color, focus-ring, or chip-container styles into `TagsInput`.
- Keep handwritten source and test files below 300 lines.
- Run `bun run preflight` before claiming completion.

---

### Task 1: Install the official Combobox primitives without overwriting existing controls

**Files:**
- Create: `packages/dashboard/src/components/ui/combobox.tsx`
- Create: `packages/dashboard/src/components/ui/input-group.tsx`
- Verify unchanged: `packages/dashboard/src/components/ui/button.tsx`
- Verify unchanged: `packages/dashboard/src/components/ui/input.tsx`
- Verify unchanged: `packages/dashboard/src/components/ui/textarea.tsx`

**Interfaces:**
- Consumes: `packages/dashboard/components.json`, existing shadcn `Button`, `Input`, and `Textarea`.
- Produces: official exports `Combobox`, `ComboboxValue`, `ComboboxContent`, `ComboboxList`, `ComboboxItem`, `ComboboxChips`, `ComboboxChip`, `ComboboxChipsInput`, and `useComboboxAnchor`.

- [ ] **Step 1: Preview the registry change**

Run:

```bash
cd packages/dashboard
bunx --bun shadcn@latest add combobox --dry-run
```

Expected: two new files (`combobox.tsx`, `input-group.tsx`) and three potential overwrites (`button.tsx`, `input.tsx`, `textarea.tsx`) are reported.

- [ ] **Step 2: Add the component without enabling overwrite**

Run:

```bash
cd packages/dashboard
bunx --bun shadcn@latest add combobox --yes
```

Expected: the two missing files are created. The command is intentionally run without `--overwrite`; existing UI files must remain unchanged.

- [ ] **Step 3: Verify the registry did not change existing controls**

Run:

```bash
git diff --exit-code -- packages/dashboard/src/components/ui/button.tsx packages/dashboard/src/components/ui/input.tsx packages/dashboard/src/components/ui/textarea.tsx
```

Expected: exit code `0` and no output. If any file differs, do not keep the generated overwrite; restore its exact pre-command content with `apply_patch` before continuing.

- [ ] **Step 4: Verify the generated files compile**

Run:

```bash
bun run --filter @aio-proxy/dashboard build
```

Expected: dashboard build passes.

- [ ] **Step 5: Commit the registry foundation**

```bash
git add packages/dashboard/src/components/ui/combobox.tsx packages/dashboard/src/components/ui/input-group.tsx
git commit -m "feat(dashboard): add combobox primitives" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Protect the TagsInput behavior with a failing component test

**Files:**
- Create: `packages/dashboard/src/components/tags-input.test.tsx`
- Test: `packages/dashboard/src/components/tags-input.test.tsx`

**Interfaces:**
- Consumes: current `TagsInput` props plus the approved future `options?: readonly string[]` prop.
- Produces: behavior coverage for free-form entry, suggestions, paste, blur, removal, Escape, and IME.

- [ ] **Step 1: Write the controlled test harness and behavior tests**

Create `packages/dashboard/src/components/tags-input.test.tsx`:

```tsx
import { describe, expect, test } from "@rstest/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { useState } from "react";
import { TagsInput } from "./tags-input";

interface TagsInputHarnessProps {
  readonly options?: readonly string[];
}

const TagsInputHarness: React.FC<TagsInputHarnessProps> = ({ options = [] }) => {
  const [value, setValue] = useState<string[]>([]);
  return (
    <>
      <label htmlFor="models">Models</label>
      <TagsInput
        id="models"
        value={value}
        onValueChange={setValue}
        placeholder="Add model"
        removeLabel={(tag) => `Remove ${tag}`}
        options={options}
      />
      <output aria-label="Selected models">{value.join("|")}</output>
    </>
  );
};

describe("TagsInput", () => {
  test("creates trimmed unique values from keys, blur, and paste", () => {
    render(<TagsInputHarness />);
    const input = screen.getByRole("combobox", { name: "Models" });
    const selected = screen.getByRole("status", { name: "Selected models" });

    fireEvent.change(input, { target: { value: " gpt-5 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "gpt-5" } });
    fireEvent.keyDown(input, { key: "," });
    fireEvent.paste(input, { clipboardData: { getData: () => "claude-4\ngemini-2, gpt-5" } });
    fireEvent.change(input, { target: { value: "mistral-large" } });
    fireEvent.blur(input);

    expect(selected).toHaveTextContent("gpt-5|claude-4|gemini-2|mistral-large");
  });

  test("selects a highlighted suggestion without creating the search draft", async () => {
    render(<TagsInputHarness options={["gpt-5", "gpt-5-mini"]} />);
    const input = screen.getByRole("combobox", { name: "Models" });

    fireEvent.change(input, { target: { value: "gpt-5" } });
    await screen.findByRole("option", { name: "gpt-5" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByRole("status", { name: "Selected models" })).toHaveTextContent("gpt-5");
  });

  test("preserves accessibility and does not clear values on Escape or IME Enter", () => {
    render(<TagsInputHarness />);
    const input = screen.getByRole("combobox", { name: "Models" });

    fireEvent.change(input, { target: { value: "draft" } });
    fireEvent.keyDown(input, { key: "Enter", which: 229 });
    expect(screen.getByRole("status", { name: "Selected models" })).toBeEmptyDOMElement();

    fireEvent.change(input, { target: { value: "gpt-5" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByRole("status", { name: "Selected models" })).toHaveTextContent("gpt-5");

    fireEvent.click(screen.getByRole("button", { name: "Remove gpt-5" }));
    expect(screen.getByRole("status", { name: "Selected models" })).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails for the missing API and behavior**

Run:

```bash
bun run --filter @aio-proxy/dashboard test:unit -- tags-input.test.tsx
```

Expected: FAIL because the current component has no `options` prop and does not render the Combobox role/option behavior.

---

### Task 3: Rebuild TagsInput as a creatable Combobox wrapper

**Files:**
- Modify: `packages/dashboard/src/components/tags-input.tsx`
- Test: `packages/dashboard/src/components/tags-input.test.tsx`

**Interfaces:**
- Consumes: official shadcn Combobox exports from Task 1 and `@base-ui/react/combobox` only for the accessible `ChipRemove` extension.
- Produces: `TagsInput` with `TagsInputProps`, optional suggestions, and the unchanged controlled string-array contract.

- [ ] **Step 1: Replace the handwritten visual control with the Combobox composition**

Implement `packages/dashboard/src/components/tags-input.tsx` with these exact responsibilities:

```tsx
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { XIcon } from "lucide-react";
import type React from "react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
            <ComboboxChip key={tag} showRemove={false}>
              {tag}
              <ComboboxPrimitive.ChipRemove
                render={<Button variant="ghost" size="icon-xs" />}
                className="-ml-1 opacity-50 hover:opacity-100"
                data-slot="combobox-chip-remove"
                aria-label={removeLabel(tag)}
              >
                <XIcon className="pointer-events-none" />
              </ComboboxPrimitive.ChipRemove>
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
```

- [ ] **Step 2: Run the focused test and fix only integration mismatches**

Run:

```bash
bun run --filter @aio-proxy/dashboard test:unit -- tags-input.test.tsx
```

Expected: PASS. If Base UI's concrete event ordering differs in Happy DOM, adjust the wrapper rather than weakening assertions about duplicate creation, Escape, IME, or accessible removal.

- [ ] **Step 3: Run dashboard checks**

Run:

```bash
bun run --filter @aio-proxy/dashboard test:unit
bun run --filter @aio-proxy/dashboard build
bun run check
```

Expected: all commands pass.

- [ ] **Step 4: Commit the behavior change**

```bash
git add packages/dashboard/src/components/tags-input.tsx packages/dashboard/src/components/tags-input.test.tsx docs/superpowers/specs/2026-07-19-tags-input-combobox-design.md
git commit -m "refactor(dashboard): build tags input on combobox" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Run repository verification

**Files:**
- Verify: all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: completed Combobox registry files and TagsInput behavior.
- Produces: evidence that formatting, unit tests, artifact checks, and workspace contracts remain valid.

- [ ] **Step 1: Run full preflight**

Run:

```bash
bun run preflight
```

Expected: exit code `0` with Biome checks, all unit tests, type checks, artifact checks, and task-graph tests passing.

- [ ] **Step 2: Inspect final scope**

Run:

```bash
git status --short
git diff HEAD~2 --stat
git diff HEAD~2 -- packages/dashboard/src/components/ui/button.tsx packages/dashboard/src/components/ui/input.tsx packages/dashboard/src/components/ui/textarea.tsx
```

Expected: only the pre-existing `.reference` entry remains untracked; the final diff contains the two new shadcn files, the TagsInput rewrite, its colocated test, and the design clarification. Existing button, input, and textarea files have no diff.
