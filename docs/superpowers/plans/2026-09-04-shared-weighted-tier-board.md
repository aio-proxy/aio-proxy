# Shared Weighted Tier Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two divergent routing-board drag implementations with one shared weighted-tier board that supports identical whole-tier and item dragging.

**Architecture:** A pure shared layout module converts ordered tiers and parking lists to and from dnd-kit's temporary list projection. A generic React board owns drag state, tier/item shells, insertion slots, collapse behavior, and share controls; Provider and model-routing wrappers supply item content plus domain-specific layout reducers.

**Tech Stack:** React 19, TypeScript, `@dnd-kit/react` 0.5, `@dnd-kit/helpers`, Base UI/shadcn components, Rstest, Testing Library, Tailwind CSS.

**Spec:** `docs/superpowers/specs/2026-09-04-shared-weighted-tier-board-design.md`

## Global Constraints

- Do not add a dependency or an "add tier" button.
- Use Provider ID, Provider priority, and Provider weight terminology.
- Keep model-routing `unused` item-droppable and `blocked` read-only; neither is a draggable tier.
- Provider routing saves compact descending priorities; model routing preserves sparse defaults/overrides and existing priorities when possible.
- Use shared `@aio-proxy/ui` controls, semantic colors, existing i18n messages, keyboard drag support, visible focus, and reduced-motion handling.
- Each `.tsx` file declares exactly one React component; shared cross-module code lives outside either domain module.
- Write each behavior test first and observe the expected failure before production edits.
- Prefix every shell command with `rtk`; edit files only with `apply_patch`.

---

### Task 1: Shared normalized tier layout

**Files:**
- Create: `packages/dashboard/src/lib/weighted-tier-layout/index.ts`
- Create: `packages/dashboard/src/lib/weighted-tier-layout/weighted-tier-layout.ts`
- Create: `packages/dashboard/src/lib/weighted-tier-layout/weighted-tier-layout.test.ts`
- Delete obsolete prototype: `packages/dashboard/src/components/routing-drop-slot.tsx`
- Delete obsolete prototype test: `packages/dashboard/src/modules/providers/components/provider-routing-board/provider-tier-slot.test.tsx`

**Interfaces:**
- Produces `WeightedTierLayout`, `WeightedTierOperation`, `weightedTierLists()`, `projectWeightedTierLayout()`, `weightedTierListId()`, `weightedTierAfterSlotId()`, `WEIGHTED_TIER_ORDER`, and `WEIGHTED_TIER_HIGH`.
- `WeightedTierLayout` contains ordered `{ id, itemIds }` tiers and a `parking` record.
- `projectWeightedTierLayout()` accepts the pre-drag layout, dnd-kit list projection, and `{ type: 'item' | 'tier'; id }`; it returns a normalized layout or the original layout for an invalid target.

- [ ] **Step 1: Delete the obsolete shared-slot prototype with `apply_patch`**

Restore the model list and Provider slot files to their committed behavior while removing `routing-drop-slot.tsx` and its prototype-only test. Do not alter committed Provider functionality yet.

- [ ] **Step 2: Write failing pure layout tests**

```ts
test('item dropped between tiers becomes a new tier', () => {
  const layout = fixtureLayout();
  const lists = weightedTierLists(layout);
  lists[weightedTierListId('high')] = [];
  lists[weightedTierAfterSlotId('high')] = ['a'];

  expect(projectWeightedTierLayout(layout, lists, { type: 'item', id: 'a' })).toEqual({
    tiers: [
      { id: 'high', itemIds: [] },
      { id: 'tier:new:1', itemIds: ['a'] },
      { id: 'low', itemIds: ['b'] },
    ].filter((tier) => tier.itemIds.length > 0),
    parking: { unused: ['c'] },
  });
});

test('tier dropped into an insertion slot moves all members together', () => {
  const layout = fixtureLayout();
  const lists = weightedTierLists(layout);
  lists[WEIGHTED_TIER_ORDER] = ['high'];
  lists[WEIGHTED_TIER_HIGH] = ['low'];

  expect(projectWeightedTierLayout(layout, lists, { type: 'tier', id: 'low' }).tiers).toEqual([
    { id: 'low', itemIds: ['b'] },
    { id: 'high', itemIds: ['a'] },
  ]);
});
```

- [ ] **Step 3: Run the test and verify RED**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- weighted-tier-layout.test.ts`

Expected: FAIL because `@/lib/weighted-tier-layout` does not exist.

- [ ] **Step 4: Implement the minimal pure layout module**

```ts
export interface WeightedTierLayout {
  readonly tiers: readonly { readonly id: string; readonly itemIds: readonly string[] }[];
  readonly parking: Readonly<Record<string, readonly string[]>>;
}

export type WeightedTierOperation = { readonly type: 'item' | 'tier'; readonly id: string };

export const WEIGHTED_TIER_ORDER = 'weighted-tier:order';
export const WEIGHTED_TIER_HIGH = 'weighted-tier:slot:high';
export const weightedTierListId = (tierId: string): string => `weighted-tier:items:${tierId}`;
export const weightedTierAfterSlotId = (tierId: string): string => `weighted-tier:slot:after:${tierId}`;
export const weightedTierParkingId = (parkingId: string): string => `weighted-tier:parking:${parkingId}`;
```

`weightedTierLists()` must populate tier order, every tier item list, every insertion slot, and every parking list. `projectWeightedTierLayout()` must reinsert a moved tier at the target slot or rebuild item groups from occupied insertion slots, preserve all other members, remove empty active tiers, generate the first collision-free `tier:new:N`, and return the original layout for unknown IDs or invalid targets.

- [ ] **Step 5: Run the pure tests and verify GREEN**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- weighted-tier-layout.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the shared layout**

```bash
rtk git add packages/dashboard/src/lib/weighted-tier-layout packages/dashboard/src/components/routing-drop-slot.tsx packages/dashboard/src/modules/providers/components/provider-routing-board/provider-tier-slot.test.tsx packages/dashboard/src/modules/routing/components/routing-board-list.tsx packages/dashboard/src/modules/providers/components/provider-routing-board/provider-tier-slot.tsx
rtk git commit -m "refactor(dashboard): normalize weighted tier layouts" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 2: Generic weighted-tier board UI

**Files:**
- Create: `packages/dashboard/src/components/weighted-tier-board/index.ts`
- Create: `packages/dashboard/src/components/weighted-tier-board/weighted-tier-board.tsx`
- Create: `packages/dashboard/src/components/weighted-tier-board/weighted-tier.tsx`
- Create: `packages/dashboard/src/components/weighted-tier-board/weighted-tier-item.tsx`
- Create: `packages/dashboard/src/components/weighted-tier-board/weighted-tier-slot.tsx`
- Create: `packages/dashboard/src/components/weighted-tier-board/weighted-tier-parking-list.tsx`
- Create: `packages/dashboard/src/components/weighted-tier-board/weighted-tier-board.test.tsx`

**Interfaces:**
- Consumes Task 1's normalized layout functions.
- Produces `WeightedTierBoard<TItem>` and the public item/tier/parking prop types.
- Calls `onLayoutChange(layout, operation)` only after a valid, non-cancelled drag.

- [ ] **Step 1: Write the failing component test**

Create a two-tier harness with literal labels and items. Assert that both tier and item handles are named, then keyboard-start a tier drag and assert every tier body has `data-collapsed="true"`; move once with the keyboard and assert the targeted insertion slot contains `data-testid="weighted-tier-preview"`; cancel and assert bodies expand and no callback fires. Add a read-only assertion that drag handles and insertion slots are absent.

```tsx
const handle = screen.getByRole('button', { name: 'Move tier 1' });
fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
await waitFor(() => expect(screen.getAllByTestId(/weighted-tier-body/)[0]).toHaveAttribute('data-collapsed', 'true'));
fireEvent.keyDown(handle, { key: 'ArrowDown', code: 'ArrowDown' });
await waitFor(() => expect(screen.getByTestId('weighted-tier-preview')).toBeInTheDocument());
fireEvent.keyDown(handle, { key: 'Escape', code: 'Escape' });
await waitFor(() => expect(screen.getAllByTestId(/weighted-tier-body/)[0]).not.toHaveAttribute('data-collapsed'));
expect(onLayoutChange).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the component test and verify RED**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- weighted-tier-board.test.tsx`

Expected: FAIL because `WeightedTierBoard` does not exist.

- [ ] **Step 3: Implement shared board types and orchestration**

```ts
export interface WeightedTierBoardItem<TItem> {
  readonly id: string;
  readonly value: TItem;
  readonly draggable: boolean;
  readonly dragLabel: string;
  readonly shareLabel?: string;
  readonly control?: {
    readonly ariaLabel: string;
    readonly min: number;
    readonly max: number;
    readonly value: number;
    readonly onChange: (value: number) => void;
  };
}

export interface WeightedTierParkingList<TItem> {
  readonly id: string;
  readonly label: string;
  readonly items: readonly WeightedTierBoardItem<TItem>[];
  readonly droppable: boolean;
}

export interface WeightedTierBoardProps<TItem> {
  readonly tiers: readonly { readonly id: string; readonly items: readonly WeightedTierBoardItem<TItem>[] }[];
  readonly parking?: readonly WeightedTierParkingList<TItem>[];
  readonly writable: boolean;
  readonly labels: {
    readonly tier: (index: number) => string;
    readonly tierCount: (count: number) => string;
    readonly dragTier: (index: number) => string;
    readonly newTier: string;
  };
  readonly renderItem: (value: TItem) => React.ReactNode;
  readonly onLayoutChange: (layout: WeightedTierLayout, operation: WeightedTierOperation) => void;
}
```

The board derives the initial layout and dnd lists from props, snapshots on drag start, applies `move()` during drag-over, renders projected entries from one item map, and normalizes the layout on drag end. Do not expose dnd-kit events to callers.

- [ ] **Step 4: Implement tier, item, slot, and parking collaborators**

`WeightedTier` uses `useSortable({ type: 'tier', group: WEIGHTED_TIER_ORDER, accept: [] })`, has a separate item droppable accepting only `item`, and collapses its body whenever `useDragOperation().source?.type === 'tier'`. `WeightedTierSlot` accepts `item` and `tier`, stays `h-2` when idle, and becomes a dashed `border-primary bg-primary/5` preview region only while occupied or targeted. `WeightedTierItem` owns the item drag handle, shared card shell, share label, and optional Slider. `WeightedTierParkingList` accepts only items when configured droppable.

- [ ] **Step 5: Run the shared UI test and verify GREEN**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- weighted-tier-board.test.tsx weighted-tier-layout.test.ts`

Expected: PASS without console errors.

- [ ] **Step 6: Commit the shared UI**

```bash
rtk git add packages/dashboard/src/components/weighted-tier-board
rtk git commit -m "feat(dashboard): add shared weighted tier board" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 3: Adapt Provider routing to the shared board

**Files:**
- Modify: `packages/dashboard/src/modules/providers/components/provider-routing-board/provider-routing-board.tsx`
- Create: `packages/dashboard/src/modules/providers/components/provider-routing-board/provider-routing-item.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/provider-routing-board/provider-routing-card.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/provider-routing-board/provider-tier.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/provider-routing-board/provider-tier-slot.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/provider-routing-board/provider-tier-header.tsx`
- Delete: `packages/dashboard/src/modules/providers/components/provider-routing-board/provider-tier-flow.tsx`
- Modify: `packages/dashboard/src/modules/providers/lib/provider-routing-board/provider-routing-board.ts`
- Modify: `packages/dashboard/src/modules/providers/lib/provider-routing-board/provider-routing-board.test.ts`

**Interfaces:**
- Consumes `WeightedTierBoard` and `WeightedTierLayout`.
- Produces `applyProviderRoutingLayout(board, layout, operation)`; no Provider-domain code consumes dnd-kit list IDs.

- [ ] **Step 1: Replace the prototype tier-move test with a failing normalized-layout test**

```ts
test('a normalized tier move preserves members and weights', () => {
  const board = buildProviderRoutingBoard(providers);
  const next = applyProviderRoutingLayout(
    board,
    { tiers: [...board.tiers].reverse().map((tier) => ({ id: tier.id, itemIds: tier.items.map((item) => item.providerId) })), parking: {} },
    { type: 'tier', id: 'tier:10' },
  );
  expect(next.tiers).toEqual([...board.tiers].reverse());
});
```

- [ ] **Step 2: Run the Provider data test and verify RED**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- provider-routing-board.test.ts`

Expected: FAIL because `applyProviderRoutingLayout` is not exported.

- [ ] **Step 3: Implement the Provider layout adapter**

Map layout item IDs back to existing board items. Tier moves only reorder intact tiers. Item moves reuse the current behavior: remove empty tiers, normalize source/target weights, equalize the target tier after a cross-tier move, and preserve unaffected tiers. Unknown item/tier IDs return the original board.

- [ ] **Step 4: Replace the Provider board assembly**

Render `WeightedTierBoard` directly. Convert each Provider item to a shared item with the existing percentage, drag label, and 1..100 control. `ProviderRoutingItem` renders only display name, Provider ID, and state badges. Remove all Provider-specific DnD wrappers and flow components.

- [ ] **Step 5: Run Provider tests and verify GREEN**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- provider-routing-board.test.ts providers-page.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit the Provider adapter**

```bash
rtk git add packages/dashboard/src/modules/providers/components/provider-routing-board packages/dashboard/src/modules/providers/lib/provider-routing-board
rtk git commit -m "refactor(dashboard): share Provider routing tiers" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 4: Add whole-tier movement to model routing

**Files:**
- Modify: `packages/dashboard/src/modules/routing/lib/routing-board/routing-board.ts`
- Modify: `packages/dashboard/src/modules/routing/lib/routing-board/routing-board.test.ts`
- Modify: `packages/dashboard/src/modules/routing/components/routing-board-canvas.tsx`
- Modify: `packages/dashboard/src/modules/routing/components/routing-board-item.tsx`
- Delete: `packages/dashboard/src/modules/routing/components/routing-board-list.tsx`
- Modify tests if selectors move: `packages/dashboard/src/modules/routing/components/routing-editor-drawer.test.tsx`

**Interfaces:**
- Consumes the shared board and normalized layout.
- Produces `applyRoutingBoardLayout({ providers, previousRows, previousLayout, nextLayout, operation })`.

- [ ] **Step 1: Write failing model tier-move tests**

Use three literal tiers with priorities 30, 20, and 10. Move priority 10 between 30 and 20 and assert only that tier becomes priority 25 while every weight and Provider membership remains unchanged. Add a tight-gap case that expects compact priorities, and a case proving blocked and unused rows are preserved.

```ts
expect(applyRoutingBoardLayout(input)).toEqual([
  { providerId: 'a', priority: 30, weight: 6000 },
  { providerId: 'b', priority: 20, weight: 4000 },
  { providerId: 'c', priority: 25, weight: 1000 },
]);
```

- [ ] **Step 2: Run the model data test and verify RED**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- routing-board.test.ts`

Expected: FAIL because `applyRoutingBoardLayout` does not exist.

- [ ] **Step 3: Implement the model layout adapter**

Replace dnd-list parsing with normalized tier groups. Existing tier IDs encode their original priority; new tiers do not. During a tier move, clear the moved tier's kept priority while retaining every other tier's value, then allocate between its new neighbors. During an item move, retain existing tier priorities and allocate only new tiers. Reuse the current fallback compaction, default omission, weight restoration, unused handling, and blocked-row preservation.

- [ ] **Step 4: Replace model board assembly**

Render active tiers, `unused`, and `blocked` through `WeightedTierBoard`. Convert the current `RoutingBoardItem` into identity/badge/reset content only; put its handle, shell, share label, and slider in the shared item component. Pass `unused` as droppable and `blocked` as read-only. Use the same tier count/header labels as Provider routing and omit insertion slots when `writable` is false.

- [ ] **Step 5: Run model and shared tests and verify GREEN**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit -- routing-board.test.ts routing-editor-drawer.test.tsx weighted-tier-board.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit model routing**

```bash
rtk git add packages/dashboard/src/modules/routing packages/dashboard/src/components/weighted-tier-board packages/dashboard/src/lib/weighted-tier-layout
rtk git commit -m "feat(dashboard): drag model routing tiers" -m "Co-authored-by: Codex <noreply@openai.com>"
```

### Task 5: Release note and complete verification

**Files:**
- Modify the existing unreleased changeset that describes this PR's Provider routing management, or create: `.changeset/<generated-name>.md`

**Interfaces:**
- No new runtime interface; verifies Tasks 1-4 as one user-visible feature.

- [ ] **Step 1: Update the pending release note**

Search `.changeset/` for the existing Provider routing note. Make it describe the shipped state: one shared drag editor for Provider and per-model priority tiers, whole-tier movement, drag-created tiers, and no add-tier button. Keep the required `aio-proxy` product package target and matching internal package bump.

- [ ] **Step 2: Run focused formatting and static checks**

Run: `rtk bun run check`

Expected: exit 0.

- [ ] **Step 3: Run Dashboard tests**

Run: `rtk bun run --filter @aio-proxy/dashboard test:unit`

Expected: all Dashboard tests pass with no new skips or console errors.

- [ ] **Step 4: Run the Impeccable detector once**

Run: `rtk node /Users/bytedance/.agents/skills/impeccable/scripts/detect.mjs --json packages/dashboard/src/components/weighted-tier-board packages/dashboard/src/modules/providers/components/provider-routing-board packages/dashboard/src/modules/routing/components`

Expected: no unresolved applicable defect.

- [ ] **Step 5: Perform bounded browser QA**

At desktop width and approximately 390 px, verify both boards with mouse and keyboard: item-to-tier, item-to-slot, tier-to-top, tier-between-tiers, cancellation, automatic collapse/expand, unused, blocked, read-only, light, and dark. Confirm the insertion target is a separate dashed region and no tier card receives a tier-drop outline.

- [ ] **Step 6: Run repository preflight**

Run: `rtk bun run preflight`

Expected: exit 0 with lint, format, and all unit tests passing.

- [ ] **Step 7: Review and commit the final diff**

Run `rtk git diff --check`, inspect `rtk git diff --stat`, then commit only the changeset or any verification-driven fixes:

```bash
rtk git add .changeset packages/dashboard
rtk git commit -m "chore: document shared routing tier editor" -m "Co-authored-by: Codex <noreply@openai.com>"
```
