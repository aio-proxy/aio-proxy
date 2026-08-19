---
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
'aio-proxy': patch
---

Author provider aliases as inline rows in the Models section instead of through a staged drawer. Each
alias is one row — client model ID, upstream model, delete — edited in place: the name is written as it is
typed, and the target, the conditional targets, and the "also keep the upstream model's original ID"
switch all read and write the stored config, so nothing is staged and nothing can go stale against it. A
name another alias already uses is reported on the row that types it and the typed text stays put, and
every row in a name collision is now marked rather than only the second one, so the row the user goes on
to fix is not the one that looks correct. Adding an alias appends a row that reports its own missing name
rather than opening a drawer, adding a conditional target starts it on the alias's own upstream model
instead of the first model in the list, and deleting an alias no longer asks for confirmation of a change
that Save has not applied yet.
