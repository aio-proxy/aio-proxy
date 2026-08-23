# aio-proxy

## 0.9.0

### Minor Changes

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks [@baranwang](https://github.com/baranwang)! - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

  Skip same-wire aliases that only restate one model at every effort. When a family also has a colliding `-tiered` wire, default the alias there and send `xhigh` to it instead of hiding that id. Merge leftover `-thinking` siblings onto `when.thinking` even if the picker omitted them.

  Accept object-form `alias.variants` on read, then store only `{ when, model, preserve }` rows. Unpreserved variant targets stay hidden from the client model list.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks [@baranwang](https://github.com/baranwang)! - The dashboard API connection editor can now select multiple protocols and give each one its own address. Saving writes the existing `endpoints` config instead of dropping it.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks [@baranwang](https://github.com/baranwang)! - Add managed OpenCode, Pi, and oh-my-pi Agent integrations. Configure them with `aio-proxy agent configure` (floors: OpenCode 1.17.10, Pi 0.84.2, oh-my-pi 17.3.7; login with `opencode auth login --provider aio-proxy` or `/login aio-proxy`). `aio-proxy upgrade` refreshes managed adapters; reload or restart the Agent after configure or upgrade. Exact string KPI values no longer lose visible precision. The plugin SDK descriptor contract, brand, and host accepted version are restored to v1; v2 descriptors are rejected. The xAI artifact smoke gate now follows plugin API v1.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca) Thanks [@baranwang](https://github.com/baranwang)! - Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a routing weight slider, and a visual model-metadata tab. OAuth providers gain a `models` whitelist that filters the discovered catalog (empty or absent exposes everything); ai-sdk providers with an OpenAI-shaped `options.baseURL` can list their catalog; oauth providers can run draft model tests; `models: []` no longer invalidates alias-only providers. The provider edit endpoint now returns the stored credentials so the editor can prefill them, replacing the previous redaction sentinels; `GET /dashboard/api/config` and `aio-proxy config` still mask secrets.

- [#190](https://github.com/aio-proxy/aio-proxy/pull/190) [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b) Thanks [@baranwang](https://github.com/baranwang)! - Add model-level Provider priority and weighted routing, stable-session candidate ordering, routing-v2 diagnostics, and a Dashboard Routing workspace. Provider weight now controls same-priority traffic instead of fixed global order; existing configurations should follow the documented migration table.

### Patch Changes

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`f8947e7`](https://github.com/aio-proxy/aio-proxy/commit/f8947e78bc3ec3c7ccfa04e6c82606d7fa7989d9) Thanks [@baranwang](https://github.com/baranwang)! - Author provider aliases as inline rows in the Models section instead of through a staged drawer. Each
  alias is one row — client model ID, upstream model, delete — edited in place: the name is written as it
  is typed, and the target, the conditional targets, and the "also keep the upstream model's original ID"
  switch all read and write the stored config, so nothing is staged and nothing can go stale against it.
  A name is written on every keystroke even when it collides with another row; every colliding row is
  marked, the list shows one duplicate-name alert, and Save stays blocked until the collision is resolved.
  Adding an alias appends a row that reports its own missing name rather than opening a drawer, adding a
  conditional target starts it on the alias's own upstream model instead of the first model in the list,
  and deleting an alias no longer asks for confirmation of a change that Save has not applied yet.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8) Thanks [@baranwang](https://github.com/baranwang)! - Fix the provider editor silently corrupting alias variants that match on thinking or speed, and let the
  Dashboard author those conditions instead of only effort names. Config supports two variant shapes — the
  compact `{ low: { model } }` record and the `[{ when: { thinking: true }, model }]` row list — but the
  editor read and wrote both through `Object.entries`, which turns a row list into `{ "0": row }`. Saving
  an unrelated field on such an alias rewrote `when: { thinking: true }` into `when: { effort: "0" }`, a
  condition no request can ever match, so the variant stopped routing with no error shown. Variants are now
  edited as condition rows: each row picks any combination of `effort` (presets plus free text), `thinking`
  and `speed`, and rows are listed in the order they are stored, so a row never moves while its own condition
  is being edited. Saves now persist variants as `{ when, model, preserve }` rows. Compact record input is still accepted on read and rewritten to rows. The editor also reports the conditions the server would refuse or
  could never match — a row with no condition at all, a blank effort, and two rows matching the same
  condition — before the save instead of after it.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`6560946`](https://github.com/aio-proxy/aio-proxy/commit/65609463e6ede5798787c54614d716f2120e8148) Thanks [@baranwang](https://github.com/baranwang)! - Align the provider editor's conditional variant rows with the prototype. Rows
  stay in the order they are stored instead of being reordered by condition
  specificity, so a row no longer jumps up the list the moment its condition is
  made more specific. Rows keep their identity across a removal, so DOM focus and
  an open condition dropdown stay with the row they belong to rather than moving to
  whichever row shifted into that position. A blank `effort` now reports the same
  "needs at least one condition" issue as an empty condition, replacing a third
  message that told the user to leave a value unset when it already was. The
  variant target dropdown drops a stray group wrapper, and the variant copy matches
  the prototype: the preserve switch names the variant, both condition errors are
  reworded, the variant target select now says which select it is instead of
  carrying the same label as the alias-level target select next to it, and the three
  condition controls name the alias they belong to instead of repeating one generic
  label per row.

- [#182](https://github.com/aio-proxy/aio-proxy/pull/182) [`bf6e779`](https://github.com/aio-proxy/aio-proxy/commit/bf6e779aad3d64f0edb4cdb4662f1063f1c6b279) Thanks [@baranwang](https://github.com/baranwang)! - Replace the dashboard JSON editor's Monaco runtime with CodeMirror 6 while keeping schema validation, completion, and hover on vscode-json-languageservice.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ed5f7b7`](https://github.com/aio-proxy/aio-proxy/commit/ed5f7b78654738c9ca75178e2a060d3be628782b) Thanks [@baranwang](https://github.com/baranwang)! - Reject dashboard and admin requests carrying a foreign `Host` header while no dashboard password is
  set. A malicious page could previously rebind its own hostname to `127.0.0.1` and read every
  unauthenticated dashboard endpoint — including the provider editor's real API keys, headers and proxy
  credentials — because the loopback check trusts the browser's connection and the CSRF check ran only
  on writes.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks [@baranwang](https://github.com/baranwang)! - The provider editor now loads an unsaved model catalog with HTTP QUERY, and leftover kind-switch fields no longer block that request.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`f25104e`](https://github.com/aio-proxy/aio-proxy/commit/f25104ea345daeb6f4ec07f5db8fe505e6ca5da6) Thanks [@baranwang](https://github.com/baranwang)! - Serve the provider editor its per-model `metadata.extend` unresolved. The edit view read the
  runtime config, where `extend` has already been merged into a flat copy of the model's models.dev
  entry, so opening a provider and saving it froze that copy into the config file and cut the model
  loose from the catalog it was tracking.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b71e13c`](https://github.com/aio-proxy/aio-proxy/commit/b71e13c8c991d3482a5446fdbd980ffc37a73ae1) Thanks [@baranwang](https://github.com/baranwang)! - Align the model metadata drawer with the editor demo. Visual-tab labels are prose
  again (reasoning, context window, cache read, and so on) instead of config key
  paths, and the JSON tab names a schema field when the draft is an object Zod
  rejects instead of claiming it is not JSON. A failed models.dev slug catalog
  response now surfaces as an error with Retry, rather than an empty catalog.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5) Thanks [@baranwang](https://github.com/baranwang)! - types: list a provider's own model ids before its aliases. The derived route list that feeds `/v1/models`,
  each provider's `clientModels`, and the provider editor's exposure preview put alias names first, so a
  provider that renames one model pushed that alias above the models the user actually typed into the
  whitelist. Direct ids now come first and aliases follow, in configuration order. Which models a provider
  exposes is unchanged — only the order of the listing.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`21883d3`](https://github.com/aio-proxy/aio-proxy/commit/21883d33ab3ceb0081e123aaa985f42b4622f33d) Thanks [@baranwang](https://github.com/baranwang)! - Clear up the wording around testing a provider in the Dashboard's provider editor. Testing a model now
  reports which model succeeded, so trying two models in a row no longer leaves an unlabelled green line that
  could refer to either, and the panel now calls what it sends a model request throughout — both the button
  and the line reporting a failure, which previously described it as a connection test even though the
  connection settings above have already been checked by that point. A failed test still says the provider can
  be saved anyway. When you sign in to a provider, the control that picks which product you are signing in to
  now asks for a sign-in method instead of an "OAuth provider", which read as if it were asking again about
  the provider you were editing.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ebaeb73`](https://github.com/aio-proxy/aio-proxy/commit/ebaeb73a04968dcb97a435a4037394a08e831a00) Thanks [@baranwang](https://github.com/baranwang)! - Give Dashboard OAuth loopback a styled completion page with a close button, and lock the plugin account form as soon as authorization starts.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`1dcaf2d`](https://github.com/aio-proxy/aio-proxy/commit/1dcaf2d27278874035494b320690b43dfc5334fa) Thanks [@baranwang](https://github.com/baranwang)! - Show an OAuth provider's models as enabled when its whitelist is empty. An empty whitelist exposes the
  whole discovered catalog at runtime, but the editor rendered every model unchecked — and the first
  click then saved a one-model whitelist, silently disabling everything else.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e) Thanks [@baranwang](https://github.com/baranwang)! - An OAuth provider's `models` whitelist is now read and validated from the config file, where it was
  previously ignored. If you had hand-written a `models` key on an OAuth provider it now takes effect and
  restricts which models that provider exposes. A malformed value — an empty model id, or a bare string
  instead of a list — is reported instead of being silently dropped: that one provider is marked invalid
  and unavailable in the Dashboard while the proxy and every other provider start normally. A re-login is
  now validated the same way before its config is written: a staged `models` whitelist that is malformed is
  rejected rather than persisted, so a re-login can no longer leave a working provider with a whitelist the
  next start refuses to read.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`30113ac`](https://github.com/aio-proxy/aio-proxy/commit/30113ac44315a690a30360121fe196f1104a69be) Thanks [@baranwang](https://github.com/baranwang)! - Stop OAuth reauthorize from writing the provider while alias names still collide. The editor already blocked Save; reauthorize went through `save()` without that check, so last-wins serialization could drop a colliding row from the config.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b0cdf26`](https://github.com/aio-proxy/aio-proxy/commit/b0cdf2696d3b8125d4d7c5a4df239a45bbe0dcc1) Thanks [@baranwang](https://github.com/baranwang)! - Keep per-model metadata edits when saving an OAuth provider also re-authorizes it. The editor saves
  credentials and model metadata in one action; if the credential half required re-authorization, the
  login path rebuilt the provider entry from a patch that had no metadata field, so the metadata half
  of the save was silently discarded.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e) Thanks [@baranwang](https://github.com/baranwang)! - Harden the OAuth provider update contract so a partial patch cannot delete a provider's display name,
  aliases, or model whitelist. Every field of a provider patch is optional on the wire, but rebuilding the
  entry treated an omitted field as "clear it", so a caller that sent only the fields it owned dropped
  config the user had authored elsewhere. The surfaces that ship today do send those fields — and a CLI
  re-login sends no patch at all, so these three fields were already safe there — so this fixes the contract
  rather than a flow you can hit. The rule it now follows is the one already fixed for per-model metadata: a
  field a save does not mention keeps its stored value. `weight` is the deliberate exception, because an
  omitted key is the only way to say "no weight", and clearing the display name now removes it instead of
  storing an empty name.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`cd6c5a3`](https://github.com/aio-proxy/aio-proxy/commit/cd6c5a3dd352ea22198d99345a6da3272510caca) Thanks [@baranwang](https://github.com/baranwang)! - Keep per-model metadata when an OAuth provider is re-authorized. Every re-login rebuilt the provider
  entry from a fixed field list that omitted `metadata`, so re-authorizing from the Dashboard or running
  `provider login` again deleted all per-model overrides — including `extend`, which is how a model
  tracks its models.dev source.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`798e1e2`](https://github.com/aio-proxy/aio-proxy/commit/798e1e2c230dd925f6a2df1741b52ee75c955852) Thanks [@baranwang](https://github.com/baranwang)! - Fold the provider editor's advanced fields into collapsed accordions. The closed bars show the current proxy mode, header count, and rewrite-rule count, and the copy now says "request rewrites" throughout.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`cff1a38`](https://github.com/aio-proxy/aio-proxy/commit/cff1a38dda0e9c6e3c0be008580f8144f62ea725) Thanks [@baranwang](https://github.com/baranwang)! - Fix what the provider editor tells you about its own identity and connection. The Provider ID field no
  longer disappears while creating an OAuth provider: it stays in place, empty and disabled, saying the
  authorization flow fills it in, so the fields beside it stop sliding across the card when the kind
  changes. The identity section states up front that the ID cannot change after saving, instead of hiding
  that under the field and repeating it twice, and the kind tiles head with the bare product names.

  The API Key field described itself by edit mode, so editing a provider that has no stored key still
  promised to "keep the stored key", and a create seeded from an existing entry claimed the field was
  empty when it was not. It now describes whether a key is actually stored, and says so with the copy the
  rest of the form uses: a key is optional for most upstreams, required for Anthropic's Bearer
  authentication.

  The protocol dropdown opens on OpenAI Compatible, which is what most third-party gateways speak, rather
  than on whichever protocol happened to be declared first. The AI SDK package field's placeholder is an
  example again — it used to be the bundled package name verbatim, so a cleared field looked like it was
  already filled with it, and saving that emptiness failed validation instead.

  Editing an OAuth provider now confirms the account it is connected to, announced to screen readers, in
  place of a read-only table that printed the account name a second time and said nothing about being
  connected. Its reauthorize button sits beside the copy that explains it, at the same size as the
  authorize button on the create screen.

  The Connection section no longer reports a blank API Key as a missing one. A provider that needs no key
  is a legitimate configuration, so the section's summary shows its address in every mode rather than
  "Missing API Key" while creating. Saving was never gated on the key.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`35dacf3`](https://github.com/aio-proxy/aio-proxy/commit/35dacf3cfbd006598e0f1f7a4082f1f2399971c6) Thanks [@baranwang](https://github.com/baranwang)! - Stop the provider editor offering a save it will reject, and rebuild its footer and section strip to
  match the rest of the page. Only sections in a `todo` state gated the save, so a provider whose OAuth
  account was never authorized — or whose weight tied with another provider — showed a green summary, an
  enabled Save, and then failed. Every section that is not `ok` now gates it, and the three conditions
  that are advisory rather than blocking (a create-time blank API key, a stale model catalog, a weight
  tie) report as `ok` with their explanation intact instead of borrowing a warning state they do not
  need.

  The footer's status line is one live region again: the sentence and the section links it points at are
  a single announcement, so "still missing" arrives with the names of what is missing rather than reading
  the lead-in alone on every keystroke. Its lead-in also describes what it actually lists — a form held
  up only by an account waiting to be authorized reads as pending, not as missing a field. The links are
  real anchors to their sections now, so they can be copied and opened like any other link, and jumping
  from either the footer or the nav strip writes the section into the address bar.

  Delete leaves the editor: an irreversible action does not belong one tab stop from Save, and the
  providers table already offers it. Section anchors drop their `editor-` prefix, so a bookmarked
  `#models` is the same link the nav strip and footer produce. The nav strip's pinned background moves to
  a wrapper so it stops sliding out from under the pills when the strip is narrow enough to scroll, and
  its active pill is marked as the current item of a list rather than claiming to link to the current
  page. The editor is finally one `<form>` element, so labels, autofill and Enter behave the way the
  platform expects.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`3cb3b81`](https://github.com/aio-proxy/aio-proxy/commit/3cb3b8135f109c0eb6ee9fab138e83ee32136ae0) Thanks [@baranwang](https://github.com/baranwang)! - Tighten the provider editor's extra request headers into a single compact row and put the proxy address on its own field. Copy now says "additional request headers" and "use a specific proxy".

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`165d4c1`](https://github.com/aio-proxy/aio-proxy/commit/165d4c1ef27a9519ff6a76387c1740643c038db1) Thanks [@baranwang](https://github.com/baranwang)! - Make the provider editor's section jump links usable from a keyboard.
  Clicking a section in the nav strip or a link in the save footer now moves keyboard focus into that
  section, not just the viewport — previously focus stayed behind, so the next Tab continued from the
  strip or from Cancel/Save rather than from the section the user asked for. The nav strip is announced as
  the form's section list instead of claiming to be "Edit Provider" even while creating one.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`e3ff7aa`](https://github.com/aio-proxy/aio-proxy/commit/e3ff7aa430a1a0d4429aa93e34f7e77836063c83) Thanks [@baranwang](https://github.com/baranwang)! - Align the provider editor's models section with the prototype. Manual add is a
  plain input plus an Add button that prepends new ids, every row has a checkbox
  and a remove control, alias targets are only the enabled models, and removing a
  whitelisted model silently drops aliases (and variants) that pointed at it. A row
  that exists only in the fetched upstream catalog is not on the whitelist, so its
  remove control is disabled and its aliases are left alone. OAuth providers get the same
  catalog button; it refreshes the saved edit-view catalog instead of calling the
  unsupported draft-catalog endpoint.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`d50d78d`](https://github.com/aio-proxy/aio-proxy/commit/d50d78d7dcdac086fb529dfbafca425ce2281e62) Thanks [@baranwang](https://github.com/baranwang)! - Fix three provider-editor model regressions. Per-model metadata is now reconciled against what was
  actually persisted, so creating a provider no longer writes an empty `{}` record for a model whose
  cost fields were cleared, while an edit that clears them still sends the explicit empty object the
  API needs to overwrite the stored one. A cost or context number whose text cannot round-trip is
  refused rather than displayed. And the manual-add box splits a comma- or newline-separated list into
  one id per row instead of committing the whole string as a single model id.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c73de2d`](https://github.com/aio-proxy/aio-proxy/commit/c73de2d1bd7c849a239d8e6a3fe139f7b6be4da6) Thanks [@baranwang](https://github.com/baranwang)! - Align the provider editor's right rail with the prototype. The model-test controls
  disappear when nothing is testable instead of leaving a disabled full-width button,
  the visible "Model to test" label becomes an accessible name only, and a pending
  test keeps the same button copy with a spinner instead of swapping in a second
  string. The exposure panel title is "Model list", its empty state says which names
  will appear, and a disabled provider folds that reason into the same sentence.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`02c0a8b`](https://github.com/aio-proxy/aio-proxy/commit/02c0a8bc9b53175e72e2cc432275a04f8fb934dc) Thanks [@baranwang](https://github.com/baranwang)! - Four provider-editor follow-ups. The save footer's lead-in now describes the list it introduces: it
  promises a missing field only when every listed section is empty, and reads "Pending" when one of them
  merely needs authorizing. The providers list prints a dash for a provider that has no configured
  weight rather than `0`, so a deliberate `0`, which is a real lowest-priority weight, is no longer
  indistinguishable from an unset one. Clearing a provider's display name and saving now removes the key
  instead of writing an empty `name` into the config file, matching what an OAuth provider already did. And
  a stored weight outside the old slider range can still be typed and saved as-is.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`a3cf9b5`](https://github.com/aio-proxy/aio-proxy/commit/a3cf9b55e0377cd8df102acf3fd9463ff5899207) Thanks [@baranwang](https://github.com/baranwang)! - A display name that is only whitespace now clears the key on an OAuth provider instead of being written
  into the config file. The empty string was already dropped, but `"   "` survived on both the ordinary
  save path and reauthorization; the editor already treats a blank-after-trim name as absent, so the
  config kept a `name` nothing would ever render. Rejecting a staged OAuth write now throws a real
  `Error`, so the structured logs that record an error's name during config recovery and session-store
  writes report `ZodError` rather than `Error` or `object`; the rejection message and its
  `providers.<id>.<field>` issue paths are unchanged.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`6fb3a79`](https://github.com/aio-proxy/aio-proxy/commit/6fb3a799f2abd3ee6f4fd11b01a7040be226257f) Thanks [@baranwang](https://github.com/baranwang)! - Fix four provider editor defects found by a re-survey against the design prototype. A malformed Base URL such
  as `api.example.com` no longer passes the Connection gate: the editor form has no validators of its own, so a
  string the mutation body's `z.url()` rejects used to show a green dot and an enabled Save, then bounce back as
  an error toast — it now marks Connection as to do, exactly as an empty Base URL does. That gate is http(s)-only,
  deliberately stricter than the mutation body's `z.url()`, which accepts any scheme: the proxy reaches an
  upstream over http(s), so a Base URL that parses as something else now blocks Save where it previously did not —
  `ftp://x.example`, and also `api.example.com:8080`, which `new URL` reads as a scheme rather than a host and
  port. The Connection badge names that case specifically, "Needs a valid http(s) address", rather than reporting
  a missing address for one that was typed. A disabled provider's
  Routing badge reads "Disabled" even when its weight ties with another provider's, instead of reporting a tie
  inside an attempt queue a disabled provider never joins. The permanent "Saved" line is gone; it never cleared
  itself, so it sat above a footer that had already gone back to listing sections to complete, duplicating the
  transient success toast the save already shows. And the OAuth authorization panel now renders above the sticky
  Save/Cancel bar rather than beneath it, so the device code, the authorization link and the manual callback
  field are no longer covered by the footer — previously, scrolling to the bottom of an OAuth authorization also
  left the footer stranded in the middle of the page.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ef90e90`](https://github.com/aio-proxy/aio-proxy/commit/ef90e90173a91816649d5c76053caf776b30e5dc) Thanks [@baranwang](https://github.com/baranwang)! - Make the provider editor's section dots agree with its Save button, and fix the section hints. A section
  missing a required field is red, one waiting on an authorization round trip is amber, a finished one stays
  primary — and any section that is not finished blocks Save. Hint counts also read "1 model" rather than
  "1 models", and an OAuth provider whose empty whitelist exposes its whole upstream catalog now says so
  instead of "0 models".

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ecb6e0c`](https://github.com/aio-proxy/aio-proxy/commit/ecb6e0c74220388cc4dd51445e994b0cef0865a5) Thanks [@baranwang](https://github.com/baranwang)! - Let the provider Routing section type any weight or priority. Clearing a field means absent, which the
  router treats as weight `1` and priority `0`. The editor shows an empty box for an absent value so it
  is distinguishable from an authored `0`.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1bcb8d`](https://github.com/aio-proxy/aio-proxy/commit/b1bcb8dc140edff15f9534a8058dd038a2ee5717) Thanks [@baranwang](https://github.com/baranwang)! - Stop the Dashboard provider editor from deleting a hand-written `endpoints` list. Saving a provider from the editor used to drop its multi-protocol `endpoints` — the mutation body schema strips the field, so every save read as "the author deleted it" — and still answer 200. The list is now retained across a save, like `headers`, `metadata`, `proxy`, and `transforms` already were.

  Also in the editor: provider sections render as cards, and the identity section says up front that the ID is fixed once saved.

- [#191](https://github.com/aio-proxy/aio-proxy/pull/191) [`5be2d7c`](https://github.com/aio-proxy/aio-proxy/commit/5be2d7c0c1f2e9d844b33ce17b3fcefc78afd62e) Thanks [@baranwang](https://github.com/baranwang)! - Raw provider `422` responses now fall through to the next live candidate. Other `4xx` statuses still return immediately.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`4c33182`](https://github.com/aio-proxy/aio-proxy/commit/4c33182e52533af7b613df3e67c82a3cba09cdb0) Thanks [@baranwang](https://github.com/baranwang)! - Fit each request transform action on one line and stop leaving a blank space where a remove action would
  show a value.

  An action used to be a bordered sub-card holding an "Action N" heading and three separately labelled
  controls, stacked. A rule with four actions therefore repeated four headings and four borders, and no two
  actions lined up. The action select and a single dotted path input now share one row per action,
  with the rule's "Then" connective on the first row and the value editor full-width beneath, so actions read
  down a column. Reorder and delete are icon buttons at the end of the row, and they are hidden entirely for a
  rule with one action, where reordering and deleting are both impossible — previously they were rendered
  disabled.

  The path input is monospace and takes the full dotted path, `request.body.temperature` or
  `request.headers.x-header-name`; the prefix picks the target and the remainder is what the field stores.

  A remove action left the value slot empty, which read as a control that had not loaded. It now says that a
  remove action needs no value.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ea6b1c9`](https://github.com/aio-proxy/aio-proxy/commit/ea6b1c98ca4c9a9ba35b39de91df4b1b25165135) Thanks [@baranwang](https://github.com/baranwang)! - Make request transform rules shorter to scan and stop showing the condition builder to rules that do not
  have a condition.

  Each rule now opens with a single row: the name is edited in place — a new rule is created named "Rule N",
  and clearing the box removes the name again, leaving "Rule N" as a hint — and reorder and delete sit beside
  it as icon buttons instead of three full-text buttons in a footer, so a rule list no longer spends a third
  of its height on chrome.

  A rule without a condition previously still rendered the full condition builder, which read as an unfinished
  condition nobody wrote. A rule now states that it runs on every request, and a switch turns the condition
  on: switching it on opens the builder with one editable condition ready to fill in, and switching it off
  removes the condition from the rule.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`0a93cfd`](https://github.com/aio-proxy/aio-proxy/commit/0a93cfd509c919280fcfea53528e1a706edd36d5) Thanks [@baranwang](https://github.com/baranwang)! - Make the request-transform value editor easier to read and fill in.

  Object and array values are no longer typed into a cramped inline box: the rule shows the value as compact
  JSON and an Edit JSON button opens a full-height editor, where Apply stays disabled until what you typed is
  really a JSON object or array of the type you picked, and Cancel throws the draft away. Because a broken
  draft now stays inside that editor, it can no longer put the whole rule list into an invalid state or lock
  you out of the JSON tab while you fix it.

  Boolean values are chosen from a true/false select instead of a checkbox labelled "True", so setting a field
  to false is a direct choice rather than an unticked box.

  The value type and the value itself now sit side by side on one row instead of stacking as two labelled rows,
  which makes rules with several actions much shorter.

  The controls are also named for what they do rather than how they work: the mode reads Fixed value, its input
  reads Value to set, and the type select reads Value type.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`e86cff1`](https://github.com/aio-proxy/aio-proxy/commit/e86cff1401ae66805faee73f5fa990a5249d52fb) Thanks [@baranwang](https://github.com/baranwang)! - Reduce the provider editor's Routing section to priority and weight number inputs. The attempt-order
  preview is gone, as is the provider-level enabled switch; a provider is enabled or disabled from the
  providers list. Creating an API or AI SDK provider now writes an explicit weight of `1` and priority
  of `0`, matching the router defaults.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c22a6ec`](https://github.com/aio-proxy/aio-proxy/commit/c22a6ec1e96f9b6e1b014f8601609565bef6ca23) Thanks [@baranwang](https://github.com/baranwang)! - Fix a Dashboard defect in the request transform stage editor. Nested expression arguments all rendered the
  same accessible name — an outer and an inner argument were both just "Field" — leaving screen reader users
  with no way to tell which control they were on. Each argument control is now named by its argument path
  ("Argument 1 → Field", "Argument 2 → Argument 1 → Field"), following the path the expression editor already
  tracks internally.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250) Thanks [@baranwang](https://github.com/baranwang)! - The provider editor's Model aliases block now offers a Sync plugin aliases button for OAuth providers
  whose plugin ships default aliases. Clicking it merges the plugin's suggestions into the alias list you
  are editing: a suggestion overwrites the alias that already carries its name, every other alias you wrote
  is kept, and names the draft does not have yet are appended. Nothing is written until you save, so the
  merge can be reviewed and undone like any other edit in the form.

  Only suggestions this provider can actually route are offered: a suggestion pointing at a model outside
  the provider's enabled models is dropped, together with any of its variants, because an alias aimed at a
  model the provider does not expose is what blocks Save. The button is absent when the provider's plugin
  has no suggestions or none survive that filter, and disabled while no upstream model is enabled. A plugin
  that returns a malformed suggestion, or throws while producing them, now costs only the suggestions — the
  editor page still opens.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`f75367e`](https://github.com/aio-proxy/aio-proxy/commit/f75367ebf14dfd6a47c86c19f0851f27065c6876) Thanks [@baranwang](https://github.com/baranwang)! - Align the request-transform condition builder and value editor with the demo:
  computed values show a live expression preview, the expression tree gets its
  indent, argument markers and connector lines, and condition groups and rows
  get their own cards instead of a fixed 768px block.

  Function names now read from one source (`+`, `CONCAT`, `IF NULL`) instead of
  a separate set of translations, condition rows drop the move buttons,
  `provider.*` is offered only inside computed values, and every value control
  announces the rule it belongs to. The expression tree's argument markers are
  localized too, so they no longer read as Chinese in the other four locales.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`476b0a8`](https://github.com/aio-proxy/aio-proxy/commit/476b0a8133f3c2a46e710e682006bf8074170bb5) Thanks [@baranwang](https://github.com/baranwang)! - Align the request-transform editor shell with the demo: one dotted path
  input, usable structure buttons on an invalid rule, and JSON-mode copy
  for unsupported or non-array drafts.

  Empty path values no longer encode as a whole-body replacement. Existing
  `$set: { 'request.body': … }` configs stay byte-identical and open in the
  JSON tab.

- [#188](https://github.com/aio-proxy/aio-proxy/pull/188) [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc) Thanks [@baranwang](https://github.com/baranwang)! - core: pin the bundled Bun runtime to 1.4.0 and restore streamed request bodies through HTTP proxies. Bun 1.4.0 ships the `fetch` + `proxy` `ReadableStream` body fix, so `createProxyFetch` no longer buffers the request. Plugin runtime compatibility is now Bun `>=1.4.0`. Compiled macOS binaries are ad-hoc re-signed after `bun build --compile` so they launch on macOS 27. Release runs on macOS so that signature is applied when the CLI is actually published.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7) Thanks [@baranwang](https://github.com/baranwang)! - Plugin default aliases now respect a provider's `models` whitelist, so a background catalog refresh can no longer insert an alias target outside it and drop the whole provider out of routing.

- [#184](https://github.com/aio-proxy/aio-proxy/pull/184) [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309) Thanks [@baranwang](https://github.com/baranwang)! - Cursor first-login now writes family aliases from AvailableModels, so clients can request names like `claude-sonnet-4-6` / `grok-4.6` and match thinking, effort, and speed onto the live wire slug.

- [#192](https://github.com/aio-proxy/aio-proxy/pull/192) [`29a90c2`](https://github.com/aio-proxy/aio-proxy/commit/29a90c24c45d4e00ada1960ca4cfd492344f6535) Thanks [@baranwang](https://github.com/baranwang)! - Grok OAuth now sends current Grok CLI identity headers and strips Codex Desktop Responses fields that `cli-chat-proxy.grok.com` rejects or hangs on.

## 0.8.0

### Minor Changes

- [#179](https://github.com/aio-proxy/aio-proxy/pull/179) [`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203) Thanks [@baranwang](https://github.com/baranwang)! - core: select alias targets from effort, thinking, and speed dimensions. A Gemini 1D variant key `off`/`OFF` no longer matches `thinkingLevel: "OFF"`; replace it with `{ "when": { "thinking": false }, "model": "…" }` (or drop the row and use the alias `model`) — shipped Antigravity defaults are unaffected.

- [#177](https://github.com/aio-proxy/aio-proxy/pull/177) [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705) Thanks [@baranwang](https://github.com/baranwang)! - API providers can declare multi-protocol `endpoints` (per-protocol or shared AI SDK-style base URLs). Raw passthrough now matches any natively supported protocol, Anthropic endpoints accept `auth: "bearer"`, and cross-protocol conversion keeps targeting the primary endpoint.

- [#176](https://github.com/aio-proxy/aio-proxy/pull/176) [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9) Thanks [@baranwang](https://github.com/baranwang)! - Allow authenticated remote model API access with labeled caller API keys.

### Patch Changes

- [#180](https://github.com/aio-proxy/aio-proxy/pull/180) [`4f73aa6`](https://github.com/aio-proxy/aio-proxy/commit/4f73aa69236d458a8ad8c811287fad03d674ad43) Thanks [@baranwang](https://github.com/baranwang)! - core: accept namespaced custom tools and align replayed Codex custom/function call history to the unique flattened tool name

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Accept Anthropic requests that combine disabled thinking with `output_config.effort`. Keep slow models.dev refreshes off the startup path. Resolve model metadata per source (config overrides catalogs). Fix overview day ranges to read `usage_daily` instead of pruned spans.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

## 0.6.4

### Patch Changes

- [#160](https://github.com/aio-proxy/aio-proxy/pull/160) [`08a579c`](https://github.com/aio-proxy/aio-proxy/commit/08a579cad9b5192820cd42f2cbb6ba18e0bc9e18) Thanks [@baranwang](https://github.com/baranwang)! - Accept empty OpenAI Responses function-call arguments when converting requests across protocols.

## 0.6.3

### Patch Changes

- [#157](https://github.com/aio-proxy/aio-proxy/pull/157) [`ba2aeae`](https://github.com/aio-proxy/aio-proxy/commit/ba2aeae4dfae3d932e2a22ac97d816b74d32a5ca) Thanks [@baranwang](https://github.com/baranwang)! - core: stop rejecting OpenAI Responses `custom_tool_call` history that has no matching custom tool declaration. Codex compaction turns replay prior custom tool calls (e.g. `apply_patch`) while sending `tools: []`, which previously produced a 501 "OpenAI Responses feature is not supported: custom_tool_call". The transform now converts that history like any other tool call.

## 0.6.2

### Patch Changes

- [#155](https://github.com/aio-proxy/aio-proxy/pull/155) [`04ed2df`](https://github.com/aio-proxy/aio-proxy/commit/04ed2dff458272169af2bf04c36cfc09372f6557) Thanks [@baranwang](https://github.com/baranwang)! - Fix empty Codex model picker for gpt-5.6 aliases. The `/v1/models` Case A passthrough now guarantees the Codex client reads a non-empty prompt: it resolves one non-empty instruction text (existing `model_messages.instructions_template`, else `base_instructions`, else the bundled template) and writes it back to `base_instructions`, also replacing a present-but-empty `instructions_template` (which the client prefers verbatim). Codex client 0.146.0 treats `base_instructions` as required and prefers `instructions_template` whenever present, so upstream rows that omit `base_instructions` (gpt-5.6-sol/terra/luna) previously failed catalog deserialization and emptied the picker.

- [#150](https://github.com/aio-proxy/aio-proxy/pull/150) [`52cb5ce`](https://github.com/aio-proxy/aio-proxy/commit/52cb5cef04cd1532dac2a773ee61b4fefd72d54d) Thanks [@baranwang](https://github.com/baranwang)! - Allow OpenAI Responses requests with image detail hints to fall back across provider protocols.

## 0.6.1

### Patch Changes

- [#138](https://github.com/aio-proxy/aio-proxy/pull/138) [`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7) Thanks [@baranwang](https://github.com/baranwang)! - Add the Rspress documentation site and its shared UI foundation.

- [#143](https://github.com/aio-proxy/aio-proxy/pull/143) [`5ab65bf`](https://github.com/aio-proxy/aio-proxy/commit/5ab65bf7ef8dd5b74e2589df30b6da7342436cb6) Thanks [@baranwang](https://github.com/baranwang)! - Support OpenAI Responses instructions and hosted web search on cross-protocol model routes.

## 0.6.0

### Minor Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`963e395`](https://github.com/aio-proxy/aio-proxy/commit/963e3951a64644441a36b0ae4c9b93d644444d18) Thanks [@baranwang](https://github.com/baranwang)! - extend: resolve per-model `metadata.extend` into effective merged metadata — inherit a models.dev catalog entry as a base layer, deep-merged under your explicit fields, so cost accounting and model resolution both see the inherited values.

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085) Thanks [@baranwang](https://github.com/baranwang)! - feat: per-provider model metadata & cost overrides

  Providers can now declare a `metadata` map keyed by upstream model id to override client-facing model metadata (name, description, token limits, capabilities) and cost accounting. User config wins over models.dev auto-discovery. Billing uses the actual hit channel's configured `cost`, and each usage row records its `priceSource` (`config`/`models-dev`/`default`). A new `router.modelContextAggregation` (`min` default / `max`) reconciles the context window when multiple providers expose the same public model.

- [#136](https://github.com/aio-proxy/aio-proxy/pull/136) [`465fa49`](https://github.com/aio-proxy/aio-proxy/commit/465fa494bc0446e11b68b0922b29ba2c15880c37) Thanks [@baranwang](https://github.com/baranwang)! - Make `count_tokens` traces distinguish upstream counts from the local estimate

  Previously a `count_tokens` request answered by the local estimator was only
  signalled by an `x-aio-proxy-token-count-estimated: true` response header, and
  candidates that were passed over before their count capability ran (no token
  count capability, unsupported image input, or a missing provider tool) left no
  span at all. A trace answered without any upstream count was therefore
  indistinguishable from an upstream success.

  The response header is removed. The local-estimate fallback now records an
  `aio_proxy.token_count` span tagged `aio_proxy.token_count.source=local_estimate`,
  and each passed-over candidate records an `aio_proxy.token_count.candidate_skipped`
  span carrying the provider id and a skip reason (`no_capability`,
  `image_unsupported`, or `missing_tool`). The observability signal moves from the
  client response into the trace, where the whole candidate loop is now visible.

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd) Thanks [@baranwang](https://github.com/baranwang)! - feat: meter image, web-search, and audio usage for per-event and audio fees

  The proxy now counts generated images and web-search invocations from served
  responses (OpenAI Responses output items and streamed AI SDK file/tool-call
  parts) and reads audio token counts from OpenAI-compatible usage. These flow
  into the configured `cost` fields (`image`, `webSearch`, `inputAudio`,
  `outputAudio`), which previously had no effect because nothing produced the
  counts. Audio tokens are treated as a subset of their input/output totals (as
  the upstream reports them) and peeled out before the text rate applies, so each
  audio token is billed once at the audio rate rather than at both rates.
  Requests without such events are unaffected.

### Patch Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`abf31a4`](https://github.com/aio-proxy/aio-proxy/commit/abf31a4c2eaa5c6fedf7dd9831f00e54d2fef8ee) Thanks [@baranwang](https://github.com/baranwang)! - Fix model-metadata projection and billing gaps:

  - `/v1/models` now reflects per-provider config metadata overrides — capabilities,
    `limit.output` (max tokens), and modalities — not just the display name and
    context window. Metadata inherited via `extend` surfaces the same way.
  - `max_input_tokens` now reports the model's maximum input tokens
    (`limit.input`) rather than the total context window, so a model whose context
    window exceeds its input limit no longer over-advertises its input capacity.
  - A flat per-request fee (`cost.request`) is now billed on a successful response
    that carries no token usage, instead of being silently dropped.
  - The generated config JSON Schema references the models.dev model-id enum for
    `metadata.extend`, so editors can autocomplete and validate the slug.

## 0.5.2

### Patch Changes

- [#133](https://github.com/aio-proxy/aio-proxy/pull/133) [`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95) Thanks [@baranwang](https://github.com/baranwang)! - Fix Docker release build failure by building `@aio-proxy/i18n` with rslib

  The `@aio-proxy/i18n` package built its declarations with `tsc -b`, unlike every other referenced workspace package (which use rslib). Because `paraglide-js compile` regenerates `src/paraglide/**` on every build, fresh/concurrent builds (such as the multi-arch Docker release) could see i18n's emitted `dist` as stale relative to its regenerated sources, so `@aio-proxy/core`'s declaration generation failed the composite project-reference check with `TS6305: Output file '.../i18n/dist/index.d.ts' has not been built from source file '.../i18n/src/index.ts'`.

  i18n now compiles messages and then builds with rslib like the other packages, emitting its declarations through the same pipeline and eliminating the fragile cross-package staleness check.

## 0.5.1

### Patch Changes

- [#131](https://github.com/aio-proxy/aio-proxy/pull/131) [`1a525e8`](https://github.com/aio-proxy/aio-proxy/commit/1a525e861a0ef77668c3321f75171bb9e2880e9f) Thanks [@baranwang](https://github.com/baranwang)! - core: fix proxied streaming passthrough dropping the request body. Bun 1.3.x
  silently discards a `ReadableStream` request body when `fetch` uses a proxy, so
  `api` providers with a `proxy` configured hung until timeout on streaming
  requests (e.g. `openai-response` passthrough). `createProxyFetch` now buffers a
  streamed request body to bytes before sending it through the proxy, so the body
  survives without changing the streaming response. This lets the build toolchain
  stay on the reproducible Bun 1.3.14 release.

## 0.5.0

### Minor Changes

- [#125](https://github.com/aio-proxy/aio-proxy/pull/125) [`7856451`](https://github.com/aio-proxy/aio-proxy/commit/7856451f2434912a619e1c72aca44a1ccd1aaf43) Thanks [@baranwang](https://github.com/baranwang)! - server: return real upstream token counts for `/v1/messages/count_tokens` when a same-protocol raw provider is configured, and replace the `bytes/64` fallback with a character-class-weighted estimator

- [#129](https://github.com/aio-proxy/aio-proxy/pull/129) [`c6ecfc0`](https://github.com/aio-proxy/aio-proxy/commit/c6ecfc0dc81e6cb0f0c5cd7b27b79f32cfb0955c) Thanks [@baranwang](https://github.com/baranwang)! - normalize and downgrade reasoning effort per upstream model capability

  Inbound reasoning-effort values are now accepted leniently and clamped to what
  each candidate upstream model actually advertises, on both the raw-passthrough
  and AI SDK model-invocation paths. This fixes a `400 ... at output_config.effort`
  error when Claude Code's ultracode mode sent effort `xhigh` to an upstream that
  only supports `low`/`medium`/`high` — the request now downgrades to the highest
  supported level instead of being rejected. Capability resolution is cache-only,
  so a cold or slow models.dev never blocks the request (it falls back to
  forwarding the client's value unchanged).

### Patch Changes

- [#127](https://github.com/aio-proxy/aio-proxy/pull/127) [`d95834a`](https://github.com/aio-proxy/aio-proxy/commit/d95834ad85ea0352f5c389497ea008c687a80d64) Thanks [@baranwang](https://github.com/baranwang)! - core: upgrade the bundled Bun runtime to the 1.4 line so proxied streaming passthrough no longer drops the request body. Bun 1.3.x silently discarded a `ReadableStream` request body when `fetch` used a proxy, so `api` providers with a `proxy` configured hung until timeout on streaming requests (e.g. `openai-response` passthrough). The compiled binary embeds the build-time Bun runtime, so this is delivered by pinning the build toolchain to Bun 1.4.

## 0.4.0

### Minor Changes

- [#124](https://github.com/aio-proxy/aio-proxy/pull/124) [`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282) Thanks [@baranwang](https://github.com/baranwang)! - i18n: restructure message keys into nested namespaces and add Traditional Chinese (zh-Hant), Japanese (ja), and Korean (ko) locales

  - Flat `cli_*`/`common_*`/`error_*`/`wizard_*` keys are now nested, dot-layered namespaces (e.g. `cli.provider.login.unknown_vendor`); dashboard/oauth/brand keys are regrouped under the same scheme.
  - Added `zh-Hant`, `ja`, and `ko` locales; `resolveLocale` now maps `zh-hant`/`zh-tw`/`zh-hk`/`zh-mo`, `ja`/`ja-*`, and `ko`/`ko-*` tags to them.
  - Removed keys that did not need translation (protocol acronyms, `N/A`, `API Key`, and similar) and inlined them at their call sites.
  - Stripped trailing sentence periods from all message values across every locale.

### Patch Changes

- [#121](https://github.com/aio-proxy/aio-proxy/pull/121) [`8c1e690`](https://github.com/aio-proxy/aio-proxy/commit/8c1e69073e52a2921101c767b6d020484b59f857) Thanks [@baranwang](https://github.com/baranwang)! - ci: fix Docker image publish reading the renamed `published-packages` output from changesets/action, so the GHCR image is tagged and pushed again on release

- [#123](https://github.com/aio-proxy/aio-proxy/pull/123) [`d460128`](https://github.com/aio-proxy/aio-proxy/commit/d4601280f29a5322a30b4baa516bc1906d0ea324) Thanks [@baranwang](https://github.com/baranwang)! - cli: fix the managed service becoming unreachable after `brew upgrade`. The service unit now records the stable PATH launcher instead of the version-pinned Cellar binary, `service restart` regenerates an already-installed unit with a freshly resolved executable (recovering units that still point at a deleted old binary), and `resolveExec` falls back to the PATH launcher when the running executable was deleted mid-upgrade. `aio-proxy upgrade` now always restarts a managed daemon after upgrading (the `--restart` flag is removed); a manually started daemon still gets a self-restart hint.

## 0.3.0

### Minor Changes

- [#117](https://github.com/aio-proxy/aio-proxy/pull/117) [`55d3ccd`](https://github.com/aio-proxy/aio-proxy/commit/55d3ccd49cb6819b8a413050a7a668efc9df17c0) Thanks [@baranwang](https://github.com/baranwang)! - cli: publish a multi-arch (amd64/arm64) Docker image to GHCR on release, and add a Dockerfile and docker-compose example for running aio-proxy in a container

### Patch Changes

- [#120](https://github.com/aio-proxy/aio-proxy/pull/120) [`38960fd`](https://github.com/aio-proxy/aio-proxy/commit/38960fd9fca94d3e38cb5277a5eb928a3962d96a) Thanks [@baranwang](https://github.com/baranwang)! - core: accept `role: "system"` messages on the Anthropic Messages endpoint (matching the official SDK's `MessageParam` union) and surface Zod validation path detail in 400 responses without leaking request values

- [#116](https://github.com/aio-proxy/aio-proxy/pull/116) [`5a6deb7`](https://github.com/aio-proxy/aio-proxy/commit/5a6deb759ed7c748369db2dee814d2686dcd2e8d) Thanks [@baranwang](https://github.com/baranwang)! - server: end streamed request traces at the upstream terminal frame instead of socket EOF, so traces no longer stay "running" after the model finished. Raw passthrough resolves completion at the terminal frame across all four protocols and the AI SDK path at the finish part, without ending the client stream. Adds a configurable upstream idle timeout (300s default) that cancels a stalled upstream and errors the client stream rather than closing it cleanly. OpenAI-compatible passthrough treats [DONE] (not finish_reason) as terminal so trailing include_usage accounting is still captured; session commit stays gated on true stream EOF.

## 0.2.1

### Patch Changes

- [#114](https://github.com/aio-proxy/aio-proxy/pull/114) [`23457e3`](https://github.com/aio-proxy/aio-proxy/commit/23457e3c2a4f306460a25aa6252e477f3bbec6ec) Thanks [@baranwang](https://github.com/baranwang)! - release: verify the end-to-end publish + single `v<version>` tag + GitHub Release flow. No user-facing behavior change.

## 0.2.0

### Minor Changes

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks [@baranwang](https://github.com/baranwang)! - cli: add a `dashboard` command that probes the running daemon and opens the web dashboard in the default browser, resolving host/port via the same control-plane logic as `status`/`doctor` (with `--host`/`--port` overrides). Exits nonzero without opening a browser when the daemon is unreachable.

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks [@baranwang](https://github.com/baranwang)! - cli: add an `upgrade` command that detects the install method (brew/bun/npm/pnpm/binary) and upgrades `aio-proxy` in place. Package-manager channels re-install a registry-pinned `pkg@version`; the binary channel does an atomic self-replace with `--version` verification, automatic rollback, and backup sweep. Supports `--check`, `--force`, `--restart`, and `--registry`, and hints to restart a running daemon.

### Patch Changes

- [#109](https://github.com/aio-proxy/aio-proxy/pull/109) [`2fdb662`](https://github.com/aio-proxy/aio-proxy/commit/2fdb662f1449087dac370988e41793760b3c4c53) Thanks [@baranwang](https://github.com/baranwang)! - ingress: tolerate unknown `detail` values on OpenAI Responses `input_image` parts. Clients such as Codex send `detail: "original"`, which previously failed the input-item union and rejected the whole request with `400 Invalid OpenAI Responses request` before any provider routing. Unrecognized values are now coerced to `undefined` (a best-effort hint), matching how downstream code already treats `detail`.
