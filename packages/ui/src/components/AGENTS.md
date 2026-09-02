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
