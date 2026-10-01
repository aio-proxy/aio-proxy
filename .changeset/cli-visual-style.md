---
'aio-proxy': minor
'@aio-proxy/cli': minor
'@aio-proxy/i18n': minor
---

The CLI has a new look. Help groups commands by purpose, `provider list` and `plugin list` print aligned tables, `agent list` and `provider list --filter <id>` print every field as a labeled block, and `doctor` is a checklist. Status uses one set of symbols (● ▲ ✗ ○) everywhere, with Dashboard teal for headings. Output stays plain when redirected or when `NO_COLOR` is set, and `--json` output is unchanged.
