# Vendored protobuf-es schemas (`agent.v1`, `aiserver.v1`)

`agent_pb.ts` and `aiserver_pb.ts` are generated protobuf-es v2 code, not
hand-written. They and their `.proto` inputs are the **only** files in this
package exempt from the 300-line limit; the exemption is enforced by `oxc.ts`
`ignorePatterns` (`packages/plugins/cursor/src/gen/**`).

## Provenance — `agent.v1`

- Upstream: https://github.com/can1357/oh-my-pi (MIT, Copyright (c) 2025 Mario Zechner)
- Commit: `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` (2026-07-21)
- `agent.proto` copied verbatim from
  `packages/ai/src/providers/cursor/proto/agent.proto`.
- `agent_pb.ts` copied verbatim from
  `packages/catalog/src/discovery/cursor-gen/agent_pb.ts`
  (produced by `protoc-gen-es v2.10.2`, `target=ts`), with a single added
  `// Source:` provenance comment after the generator banner.

## Provenance — `aiserver.v1`

- Upstream: https://github.com/schultzp2020/pi-extensions (MIT, Copyright (c) 2026 Paul Schultz)
- Commit: `5517dbc4c857d48070a5267ef0ddc000a16f1a5f` (2026-08-13)
- `aiserver.proto` copied from
  `packages/pi-cursor/proto/aiserver.proto`
  (https://raw.githubusercontent.com/schultzp2020/pi-extensions/5517dbc4c857d48070a5267ef0ddc000a16f1a5f/packages/pi-cursor/proto/aiserver.proto)
  with the single local modification described below (`ModelVariantConfig` and
  `AvailableModel.variants = 30`). The upstream file was taken whole, not
  sliced here.
- `aiserver_pb.ts` generated locally from that `.proto` with
  `protoc-gen-es 2.10.2` (`target=ts`), with a single added `// Source:`
  provenance comment after the generator banner.

Cursor does not publish an `aiserver.proto`, and oh-my-pi never vendored one
(searched every commit of https://github.com/can1357/oh-my-pi — only
`agent.proto` exists). The only complete public `aiserver.v1` schema,
`everestmz/cursor-rpc` `cursor/aiserver/v1/aiserver.proto`, predates
`use_model_parameters` (its `AvailableModelsRequest` stops at field 2) and is
therefore unusable.

### Verified against the shipping client

Every field name, number, and type in `aiserver.proto` was checked against the
protobuf-es runtime metadata embedded in `cursor-agent` `2026.08.11-e8db854`
(`index.js`, `typeName="aiserver.v1.AvailableModels*"`). All of them match.

The upstream schema is a partial view of the wire types: the client also
declares request fields `scope = 10`, `use_react_model_picker = 11`,
`use_cloud_agent_effort_modes = 12`, `admin_settings_group_public_id = 13`,
`byok_enabled = 14`; response fields `composer_model_config = 4` through
`quick_agent_model_config = 10`, `disable_unused_models_after_n_hours = 12`,
`upgrade_unchanged_models_after_n_hours = 13`, `display_configuration = 15`,
`subagent_model_configs = 16`, `experimental_model_id = 19`,
`experimental_model_display_name = 20`,
`nudge_new_chats_to_auto_optimize_for = 21`; and `AvailableModel` fields
including `parameter_definitions = 29`. `AvailableModel.variants = 30` is now
declared from that client metadata, as nested `ModelVariantConfig` with the
client's scalar field numbers: `display_name = 2`, `is_max_mode = 3`,
`is_default_max_config = 4`, `is_default_non_max_config = 5`, `tagline = 7`,
`display_name_outside_picker = 8`, `variant_string_representation = 9`,
`legacy_slug = 11`. Nested `parameter_values = 1`, `tooltip_data = 6`, and
`confirmation_dialogue = 10` stay omitted (unknown fields are wire-safe).
Omitting the remaining undeclared fields is also wire-safe; anything that
needs those types must extend the schema from the client metadata rather than
guessing field numbers.

## Local modifications

One deviation from verbatim in `agent.proto`: upstream has the comment
`// @deprecated turnsOld = [];` on its own line between `turns_old`
(field 2) and `root_prompt_messages_json` (field 1). protobuf-es attaches a
leading comment to the *following* field, so the `@deprecated` JSDoc landed on
`rootPromptMessagesJson` — the field this plugin actively uses — and the
type-aware `no-deprecated` lint flagged every read/write of it. The deprecated
field is `turns_old`, not `root_prompt_messages_json`. Fix: moved the comment
to a trailing comment on the `turns_old` line in `agent.proto` and dropped the
mis-attached `@deprecated` block from `rootPromptMessagesJson` in `agent_pb.ts`.
When regenerating, keep the comment trailing on `turns_old` so the tag does not
re-attach to the next field.

`aiserver.proto` adds `AvailableModelsResponse.ModelVariantConfig` and
`AvailableModel.variants = 30` from the cursor-agent `2026.08.11-e8db854`
client metadata. No field numbers were invented.

## Regeneration

Regenerate from the vendored `.proto` files with protobuf-es v2:

```sh
# requires @bufbuild/protoc-gen-es@2.10.2 and buf (or protoc) on PATH
protoc \
  --plugin=protoc-gen-es=$(bun pm bin)/protoc-gen-es \
  --es_out=. --es_opt=target=ts \
  agent.proto aiserver.proto
```

Do not hand-trim a subset of `agent.proto`: later runtime tasks import many
message schemas across the file, and a partial vendor would silently drop
oneof cases the exec/stream mappers depend on.

## License

Both upstreams are MIT-licensed. `agent.proto`/`agent_pb.ts` are redistributed
under [LICENSE](./LICENSE) (oh-my-pi); `aiserver.proto`/`aiserver_pb.ts` under
[LICENSE.pi-extensions](./LICENSE.pi-extensions).
