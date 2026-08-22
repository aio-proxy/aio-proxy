---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Make the provider editor's section jump links usable from a keyboard.
Clicking a section in the nav strip or a link in the save footer now moves keyboard focus into that
section, not just the viewport — previously focus stayed behind, so the next Tab continued from the
strip or from Cancel/Save rather than from the section the user asked for. The nav strip is announced as
the form's section list instead of claiming to be "Edit Provider" even while creating one.
