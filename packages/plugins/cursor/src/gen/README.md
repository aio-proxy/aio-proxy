# Vendored protobuf-es schema (`agent.v1`)

`agent_pb.ts` is generated protobuf-es v2 code, not hand-written. It and
`agent.proto` are the **only** files in this package exempt from the 300-line
limit; the exemption is enforced by `oxc.ts` `ignorePatterns`
(`packages/plugins/cursor/src/gen/**`).

## Provenance

- Upstream: https://github.com/can1357/oh-my-pi (MIT, Copyright (c) 2025 Mario Zechner)
- Commit: `89d6a8f6d14286f32f09ec9c8aa8af7b3451d2d6` (2026-07-21)
- `agent.proto` copied verbatim from
  `packages/ai/src/providers/cursor/proto/agent.proto`.
- `agent_pb.ts` copied verbatim from
  `packages/catalog/src/discovery/cursor-gen/agent_pb.ts`
  (produced by `protoc-gen-es v2.10.2`, `target=ts`), with a single added
  `// Source:` provenance comment after the generator banner.

## Local modifications

One deviation from verbatim: in upstream `agent.proto` the comment
`// @deprecated turnsOld = [];` sits on its own line between `turns_old`
(field 2) and `root_prompt_messages_json` (field 1). protobuf-es attaches a
leading comment to the *following* field, so the `@deprecated` JSDoc landed on
`rootPromptMessagesJson` — the field this plugin actively uses — and the
type-aware `no-deprecated` lint flagged every read/write of it. The deprecated
field is `turns_old`, not `root_prompt_messages_json`. Fix: moved the comment
to a trailing comment on the `turns_old` line in `agent.proto` and dropped the
mis-attached `@deprecated` block from `rootPromptMessagesJson` in `agent_pb.ts`.
When regenerating, keep the comment trailing on `turns_old` so the tag does not
re-attach to the next field.

## Regeneration

Regenerate from the vendored `agent.proto` with protobuf-es v2:

```sh
# requires @bufbuild/protoc-gen-es@2.10.2 and buf (or protoc) on PATH
protoc \
  --plugin=protoc-gen-es=$(bun pm bin)/protoc-gen-es \
  --es_out=. --es_opt=target=ts \
  agent.proto
```

Do not hand-trim a subset of the schema: later runtime tasks import many
message schemas across the file, and a partial vendor would silently drop
oneof cases the exec/stream mappers depend on.

## License

Upstream is MIT-licensed (see the oh-my-pi `LICENSE`). The generated code and
`.proto` are redistributed here under those terms.
