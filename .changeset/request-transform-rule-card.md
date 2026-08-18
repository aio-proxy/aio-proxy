---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Make request transform rules shorter to scan and stop showing the condition builder to rules that do not
have a condition.

Each rule now opens with a single row: the name is edited in place — an unnamed rule shows "Rule 1" as a
hint rather than a stored name — and reorder and delete sit beside it as icon buttons instead of three
full-text buttons in a footer, so a rule list no longer spends a third of its height on chrome.

A rule without a condition previously still rendered the full condition builder, which read as an unfinished
condition nobody wrote. A rule now states that it runs on every request, and a switch turns the condition
on: switching it on opens the builder with one editable condition ready to fill in, and switching it off
removes the condition from the rule.
