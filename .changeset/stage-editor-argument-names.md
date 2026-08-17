---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Fix two Dashboard defects in the request transform stage editor. Function names in the expression editor
were rendered from the library's built-in English metadata, so `CONCAT`, `IF_NULL` and the rest stayed
untranslated no matter which locale was active; they now come from the localized function registry
alongside every other label in that editor. Nested expression arguments also all rendered the same
accessible name — an outer and an inner argument were both just "Field" — leaving screen reader users with
no way to tell which control they were on. Each argument control is now named by its argument path
("Argument 1 → Field", "Argument 2 → Argument 1 → Field"), following the path the expression editor
already tracks internally.
