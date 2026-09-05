---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'@aio-proxy/ui': patch
'aio-proxy': patch
---

Make a quota reset redemption legible while it happens. The redeem button lives inside the quota popup, so its confirmation is now inline — next to the count being spent, instead of behind a second stacked frame that covered the reading the decision is made from. While the redemption is in flight the button is replaced in place by a spinner, so the wait is visible rather than looking like a dead click, and the confirmation cannot be re-offered against a count that is already being spent. Redeeming the last available credit keeps that spinner until the request settles, instead of removing it the moment the refreshed count reaches zero mid-request. The prompt no longer names the Provider the popup header already identifies, and it is announced to whichever button is focused. Focus follows the redemption instead of dropping to the page: onto the spinner for the wait, and back onto the redeem button — or onto the popup, when the last credit leaves no button to return to — whether the redemption completes or is cancelled.

A redemption can no longer be spent twice. Closing the quota popup and reopening it before the request settled used to present the confirmation again over the stale count, and confirming spent a second credit; the wait is now read from the pending redemption itself, which outlives the popup. An open confirmation is also retracted when a refresh finds the inventory emptied elsewhere, rather than offering a credit that no longer exists.

Toasts now render above dialogs and sheets instead of being dimmed and blurred by their backdrop, so the confirmation a modal action gives is actually legible.
