# Shared weighted tier board design

**Date:** 2026-09-04
**Status:** Approved direction; implementation not started

## Summary

The Provider routing manager and the per-model routing editor will use one shared weighted-tier board. The shared component owns the complete interaction language: dragging whole priority tiers, dragging individual entries, creating a tier by dropping into an insertion slot, editing same-tier traffic share, collapsing tiers during a tier drag, and keyboard-accessible drag handles.

The two callers supply normalized tier data and render the identity-specific item content. Their domain adapters remain separate because their persistence rules differ: Provider routing writes a compact global priority sequence, while model routing preserves sparse Provider defaults and overrides, zero-weight unused entries, blocked entries, and existing priority values whenever possible.

## Goals

- Make whole-tier and individual-entry drag behavior identical in both routing surfaces.
- Remove the "add tier" action; dropping an entry into a top or between-tier slot creates the tier.
- Use a separate teal dashed insertion slot instead of outlining an existing tier as the destination for tier movement.
- Collapse active tier bodies while a tier is dragged and restore them on drop or cancellation.
- Keep the item identity and domain mutation logic pluggable without duplicating drag orchestration.
- Preserve current save, reset, disabled, read-only, and validation behavior.

## Non-goals

- Unifying the Provider-routing and model-routing configuration schemas or mutation payloads.
- Making `unused` or `blocked` into draggable priority tiers.
- Introducing a new dependency, arbitrary tier naming, direct numeric priority editing, or a second board style.

## Shared component boundary

`WeightedTierBoard<TItem>` will live in the Dashboard shared component layer because it has two module consumers. It receives:

- ordered tiers with stable IDs and ordered items;
- item identity, current traffic share, editability, and drag eligibility;
- translated tier, count, drag-handle, insertion-slot, and optional parking-list labels;
- a `renderItem` slot for model- or Provider-specific identity, badges, and actions;
- callbacks for share changes and committed item or tier layout changes;
- optional parking lists such as model routing's `unused` and read-only `blocked` sections.

The shared component and its private collaborators own:

- the single `DragDropProvider` and temporary drag projection;
- sortable tier headers and sortable item shells;
- top and between-tier droppable slots;
- the common tier container, item container, drag handles, share control, and focus behavior;
- collapse and preview state for tier dragging;
- cancellation cleanup and dispatch of one committed normalized layout.

The public callback reports a normalized layout rather than exposing dnd-kit events. It contains the ordered active tiers and their item IDs plus any mutable parking-list membership. This keeps dnd-kit mechanics out of both domain reducers.

## Interaction contract

### Individual entry drag

- Active tier bodies remain expanded.
- Dropping on an existing tier moves the entry into that tier.
- Dropping on the top or a between-tier dashed slot creates a new tier at that position.
- An empty source tier disappears after a committed move.
- Model routing's `unused` list accepts eligible entries; `blocked` remains read-only.

### Whole-tier drag

- Every active tier body collapses to its header as soon as a tier drag starts, reducing the board to a compact priority outline.
- Only tier headers are draggable as tiers. Item handles continue to drag only their item.
- The prospective destination is an independent teal dashed slot containing a compact header preview; the target tier card is not outlined as the destination.
- Dropping moves the tier and all its entries together, preserving their order and weights. It never merges the tier into another tier.
- Drop, cancellation, and keyboard cancellation clear the preview and expand all tier bodies again.

### Share editing

- The shared item shell renders one consistent share label and slider treatment.
- Callers provide the displayed share and translate the committed share back to their authored weights.
- A one-entry tier does not show an adjustable slider because its effective share is always 100%.

### Read-only and accessibility

- Read-only boards render the same hierarchy without drag or share controls.
- Tier and item handles retain translated accessible names, visible focus, and dnd-kit's keyboard sensor behavior.
- Motion is short and state-explanatory, and is disabled under reduced-motion preferences.

## Domain adapters

### Provider routing

`ProviderRoutingBoard` converts `ProviderRoutingBoardModel` into the normalized shared layout and renders Provider identity/status content. On commit it rebuilds the Provider board, normalizes affected same-tier weights, removes empty tiers, and leaves `providerRoutingMutation` responsible for compact descending priorities at save time.

### Model routing

`RoutingBoardCanvas` converts the effective model routing draft into the same normalized layout and renders the model-routing Provider content, including reset and eligibility state. Its adapter maps a whole-tier reorder to new priorities while preserving tier membership and weights. It continues to omit values equal to Provider defaults, restore a positive weight when an unused Provider becomes active, preserve blocked rows, interpolate open priority values where possible, and compact priorities only when no integer gap remains.

`unused` participates only in item movement. `blocked` is rendered through the optional read-only parking-list slot and never enters active tier order.

## Failure and cancellation behavior

- Unknown or stale item/tier IDs leave the domain state unchanged.
- A drop without a valid destination leaves the state unchanged.
- Drag cancellation restores the pre-drag layout and expanded state.
- The existing form and save paths continue to own validation and persistence errors; the shared board performs no network work.

## Testing

- Add a shared board behavior test proving tier handles, item handles, collapsed tier bodies, independent insertion-slot preview, cancellation recovery, and read-only behavior.
- Add model-routing pure-data tests proving a whole-tier move preserves membership and weight, changes only the required priorities, preserves blocked/unused rows, and compacts only when necessary.
- Keep Provider-routing tests for whole-tier movement, item-created tiers, same-tier share totals, and compact save priorities.
- Run the affected Dashboard tests during development, then `bun run check` and `bun run preflight`.
- Visually verify the Provider and model-routing boards at desktop and approximately 390 px widths, using mouse and keyboard drag paths in light and dark themes.

