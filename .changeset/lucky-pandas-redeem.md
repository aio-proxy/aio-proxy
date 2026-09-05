---
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'@aio-proxy/server': minor
'@aio-proxy/ui': minor
'aio-proxy': minor
---

Redeem ChatGPT rate-limit reset credits from the Dashboard. The OpenAI ChatGPT plugin now implements the OAuth quota `reset` capability, and the quota popup turns an available credit count into a redeem button that confirms inline — inside the popup, next to the count being spent, instead of behind a second stacked frame. While the redemption is in flight the button is replaced in place by a spinner, so the wait is visible rather than looking like a dead click, and the confirmation cannot be re-offered against a count that is already being spent. The reading is invalidated afterwards so the spent credit disappears immediately — including when the redemption is refused because the credit was already spent elsewhere, so the button cannot be re-offered for the rest of the cooldown. Only credits the upstream reports as available Codex rate-limit grants are counted.

Toasts now render above dialogs and sheets instead of being dimmed and blurred by their backdrop, so the confirmation a modal action gives is actually legible.
