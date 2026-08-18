---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Clear up the wording around testing a provider in the Dashboard's provider editor. Testing a model now
reports which model succeeded, so trying two models in a row no longer leaves an unlabelled green line that
could refer to either, and the panel now calls what it sends a model request throughout — both the button
and the line reporting a failure, which previously described it as a connection test even though the
connection settings above have already been checked by that point. A failed test still says the provider can
be saved anyway. When you sign in to a provider, the control that picks which product you are signing in to
now asks for a sign-in method instead of an "OAuth provider", which read as if it were asking again about
the provider you were editing.
