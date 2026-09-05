---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'@aio-proxy/ui': patch
'aio-proxy': patch
---

Make a quota reset redemption legible while it happens. The redeem button lives inside the quota popup, so its confirmation is now inline — next to the count being spent, instead of behind a second stacked frame that covered the reading the decision is made from. While the redemption is in flight the button is replaced in place by a spinner, so the wait is visible rather than looking like a dead click, and the confirmation cannot be re-offered against a count that is already being spent. The prompt no longer names the Provider the popup header already identifies, and it is announced to whichever button is focused. Focus follows the redemption instead of dropping to the page: onto the spinner for the wait, and back onto the redeem button whether the redemption completes or is cancelled.

Toasts now render above dialogs and sheets instead of being dimmed and blurred by their backdrop, so the confirmation a modal action gives is actually legible.
