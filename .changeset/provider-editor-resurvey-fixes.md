---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Fix four provider editor defects found by a re-survey against the design prototype. A malformed Base URL such
as `api.example.com` no longer passes the Connection gate: the editor form has no validators of its own, so a
string the mutation body's `z.url()` rejects used to show a green dot and an enabled Save, then bounce back as
an error toast — it now marks Connection as to do, exactly as an empty Base URL does. A disabled provider's
Routing badge reads "Disabled" even when its weight ties with another provider's, instead of reporting a tie
inside an attempt queue a disabled provider never joins. The permanent "Saved" line is gone; it never cleared
itself, so it sat above a footer that had already gone back to listing sections to complete, duplicating the
transient success toast the save already shows. And the OAuth authorization panel now renders above the sticky
Save/Cancel bar rather than beneath it, so the device code, the authorization link and the manual callback
field are no longer covered by the footer — previously, scrolling to the bottom of an OAuth authorization also
left the footer stranded in the middle of the page.
