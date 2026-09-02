---
'@aio-proxy/ui': patch
'aio-proxy': patch
---

Restore the accessible names on the combobox clear and chip remove buttons

A `shadcn add combobox --overwrite` had discarded the hand-applied patch, leaving both icon-only
buttons announced as an unnamed "button" and forwarding the localized labels to the DOM as dead
attributes. The same overwrite re-hid the chevron trigger whenever a value was set, which left a
pointer user on a filled field with no visible control that reveals the curated list.
