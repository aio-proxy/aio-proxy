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
