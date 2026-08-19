---
'@aio-proxy/ui': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Keep the dropdown chevron visible on the two provider fields that have a clear button. A combobox built
from the shared input primitive hid its chevron as soon as a clear button appeared, leaving the AI SDK
package field — which is never empty, because it defaults to a package — with nothing on screen to say
it has a curated package list to pick from, and the models.dev extend field lost the same affordance
once a slug was picked. The chevron now stays beside the clear button instead of being replaced by it.
Comboboxes with no clear button, such as the OAuth capability picker, were never affected. The clear
button is also no longer an anonymous icon: it takes a translated accessible name, and the package
field's visible "Package Name" label is once again the input's accessible name rather than being
shadowed by a duplicate `aria-label`.
