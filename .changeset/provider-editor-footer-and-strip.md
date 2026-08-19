---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Stop the provider editor offering a save it will reject, and rebuild its footer and section strip to
match the rest of the page. Only sections in a `todo` state gated the save, so a provider whose OAuth
account was never authorized — or whose weight tied with another provider — showed a green summary, an
enabled Save, and then failed. Every section that is not `ok` now gates it, and the three conditions
that are advisory rather than blocking (a create-time blank API key, a stale model catalog, a weight
tie) report as `ok` with their explanation intact instead of borrowing a warning state they do not
need.

The footer's status line is one live region again: the sentence and the section links it points at are
a single announcement, so "still missing" arrives with the names of what is missing rather than reading
the lead-in alone on every keystroke. Its lead-in also describes what it actually lists — a form held
up only by an account waiting to be authorized reads as pending, not as missing a field. The links are
real anchors to their sections now, so they can be copied and opened like any other link, and jumping
from either the footer or the nav strip writes the section into the address bar.

Delete leaves the editor: an irreversible action does not belong one tab stop from Save, and the
providers table already offers it. Section anchors drop their `editor-` prefix, so a bookmarked
`#models` is the same link the nav strip and footer produce. The nav strip's pinned background moves to
a wrapper so it stops sliding out from under the pills when the strip is narrow enough to scroll, and
its active pill is marked as the current item of a list rather than claiming to link to the current
page. The editor is finally one `<form>` element, so labels, autofill and Enter behave the way the
platform expects.
