# shadcn UI Source

Files in this directory are managed by the shadcn CLI and must not be edited manually.

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
