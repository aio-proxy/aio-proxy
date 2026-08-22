---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Reduce the provider editor's Routing section to a single routing weight. The attempt-order preview —
one ranked queue per exposed model alias — is gone, as is the provider-level "enabled" switch that
greyed out the weight control; a provider is now enabled or disabled from its row on the providers
list, which has always carried that switch. Disabling a provider there still shows as "disabled" on
the Routing badge when you open the editor, and a weight shared with another provider serving the same
alias is still reported there too. The weight description regains the sentence explaining that session
affinity can override the order weight implies, which previously sat under the removed preview and
would otherwise have disappeared from the page. Creating an API or AI SDK provider now writes an explicit
weight of 0, so the badge, the slider position and the stored value agree instead of reading "no weight set"
beside a slider parked at zero; attempt order is unchanged, since an absent weight was already treated
as 0 when ordering candidates.
