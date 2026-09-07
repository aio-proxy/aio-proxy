---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-github-copilot': minor
'@aio-proxy/plugin-google-antigravity': minor
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-cursor': minor
'@aio-proxy/plugin-xai-grok': minor
---

dashboard: mark the even-burn position on each subscription quota bar

A quota bar whose window length is known now draws a 1px tick where a perfectly even burn would
have left the allowance by now. The tick is outlined in the track color on both sides so it stays
readable over the fill, and it turns red when the window is being spent faster than evenly. A
window burning within two percent of even draws no tick, since there the marker would sit on the
fill edge and restate what the bar already shows. The reading is also spoken by the bar's
accessible value text, so it is not a colour-only signal.

plugin-sdk: `OAuthQuotaItem` gains an optional `windowMinutes`, the whole-minute length of the
window a `resetsAt` closes. It is what makes the even-burn position computable; a plugin should
report it only when the upstream states the duration or both ends of the period, never as a guess
from a window label. Items without it render exactly as before, with no tick.

The bundled OAuth plugins now report it where the upstream supports it: ChatGPT
(`limit_window_seconds`), Antigravity (the two canonical 5-hour and weekly windows only), Kimi
(`window.duration` with a recognized unit), Cursor and Grok (both ends of the billing period, which
were previously parsed and discarded), and GitHub Copilot (a calendar month back from the stated
reset date — the only case with no start in the payload).
