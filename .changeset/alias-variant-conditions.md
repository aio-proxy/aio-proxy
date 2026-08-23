---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'@aio-proxy/types': patch
'aio-proxy': patch
---

Fix the provider editor silently corrupting alias variants that match on thinking or speed, and let the
Dashboard author those conditions instead of only effort names. Config supports two variant shapes — the
compact `{ low: { model } }` record and the `[{ when: { thinking: true }, model }]` row list — but the
editor read and wrote both through `Object.entries`, which turns a row list into `{ "0": row }`. Saving
an unrelated field on such an alias rewrote `when: { thinking: true }` into `when: { effort: "0" }`, a
condition no request can ever match, so the variant stopped routing with no error shown. Variants are now
edited as condition rows: each row picks any combination of `effort` (presets plus free text), `thinking`
and `speed`, and rows are listed in the order they are stored, so a row never moves while its own condition
is being edited. Saves now persist variants as `{ when, model, preserve }` rows. Compact record input is still accepted on read and rewritten to rows. The editor also reports the conditions the server would refuse or
could never match — a row with no condition at all, a blank effort, and two rows matching the same
condition — before the save instead of after it.
