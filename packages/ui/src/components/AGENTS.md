# shadcn UI Source

Files in this directory are managed by the shadcn CLI and must not be edited manually, except the
hand-authored components listed at the end.

Run additions and overwrites only from packages/ui:

```sh
bun x --bun --no-install shadcn add <component> --overwrite
```

## Sanctioned Hand Edits

An overwrite discards these; re-apply them in the same change. Nothing else in this directory may be
edited by hand.

- `dialog.tsx`: `closeLabel?: React.ReactNode` on `DialogContent`, rendered in the close button's
  `sr-only` span. The label must be localized and this package deliberately has no `@aio-proxy/i18n`
  dependency, so the caller supplies it.
- `combobox.tsx`: `clearLabel` on `ComboboxClear` (threaded through `ComboboxInput` and paired with
  `showClear` by `ComboboxClearPairProps`) and `removeLabel` on `ComboboxChip`, both as `aria-label`
  on their icon-only button. Same reason as `dialog.tsx`; the required pair makes an unnamed clear
  button a compile error rather than a silently English one. Also: the chevron trigger must NOT carry
  `group-has-data-[slot=combobox-clear]/input-group:hidden` — see the comment at that call site.
  An overwrite has already deleted this patch once (`7157fe8c`), taking the chevron fix with it.
- `toast.tsx`: `z-100` on `ToastViewport` instead of the generated `z-50`. `dialog.tsx` and `sheet.tsx`
  put both their overlay and content at `z-50`, and `Toaster` is mounted once from the root layout while
  a modal's backdrop is portalled later — so at an equal z-index the backdrop wins and dims and blurs
  the toast that is the only feedback a modal action gives. Keep the viewport above that layer.
- `switch.tsx`: the `supportsNativeSwitch` branch rendering `<input type="checkbox" switch>` on Safari
  17.4+, plus the `SwitchProps` type that narrows `SwitchPrimitive.Root.Props` and simplifies
  `onCheckedChange` to `(checked: boolean) => void`. The branch is deliberately limited to
  `size="default"`: `appearance: auto` honours only `accent-color`, so the `sm` geometry cannot be
  reproduced natively.
- `card.tsx`: `Card` is built on `useRender` (with `mergeProps`, like `badge.tsx`) so it accepts a
  `render` prop, and exposes `slot`/`size` as state instead of hand-written `data-*` attributes. The
  dashboard's Agent cards render the whole card as a router link through it; wrapping a `Card` in an
  `<a>` instead nests the card's ring and focus styles inside a second focus target.

## Hand-Authored Components

Components the shadcn registry does not ship yet, written the way its generated files are (one
function per part, a `data-slot` on each, `cn` merging, the same tokens as the neighbouring controls).
They are not in the registry, so `shadcn add` never overwrites them. When the registry gains one,
replace the file with the generated version and move call sites over to its API.

- `number-field.tsx`: Base UI `number-field` (`NumberField`, `NumberFieldGroup`, `NumberFieldInput`,
  `NumberFieldDecrement`, `NumberFieldIncrement`, `NumberFieldScrubArea`,
  `NumberFieldScrubAreaCursor`). The group carries `Input`'s frame (`h-8`, `rounded-2xl`,
  `bg-input/50`, ring focus, destructive invalid state); the steppers default to lucide minus/plus.
  Base UI's English accessible names are not let through: the steppers require a localized
  `aria-label` (a compile error otherwise), and the input drops the default
  `aria-roledescription="Number field"` unless the caller passes one.
