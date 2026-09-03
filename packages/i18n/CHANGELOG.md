# @aio-proxy/i18n

## 0.16.0

## 0.15.0

## 0.14.0

### Minor Changes

- [#245](https://github.com/aio-proxy/aio-proxy/pull/245) [`3408993`](https://github.com/aio-proxy/aio-proxy/commit/340899373f0244e6dd240459d6e02d187998961f) Thanks [@olivewind](https://github.com/olivewind)! - Let AI SDK provider packages be installed from a configurable npm registry in the dashboard, and load model catalogs from packages that expose an optional `listModels` method.

## 0.13.0

### Minor Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d) Thanks [@baranwang](https://github.com/baranwang)! - Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

  Each Provider — including each OAuth account — is now one card showing its name, kind, protocols,
  plan, routing priority and weight, 24-hour success rate and p95 latency, model count, and request
  count, with search and availability/enablement/kind filters replacing the old table's pagination and
  grouping. OAuth Providers whose plugin exposes a quota capability show a remaining-quota ring that
  opens a detail dialog with one bar per quota window that reports a remaining amount.

  The quota read is cached in memory behind a per-provider five-minute cooldown, refreshed
  asynchronously once a Provider has finished answering a model request, and exposed at
  `QUERY /dashboard/api/providers/:id/quota`; the dialog's refresh button bypasses the cooldown, and the
  Providers page polls the reading the way it already polls health. `OAuthQuotaSnapshot` gains an
  optional `plan`, which `kimi-code` and `xai-grok` now populate, and `xai-grok` also reports per-product
  usage. Dashboard Provider summaries gain `protocols` and `hasQuota` in place of the single `protocol`
  field.

## 0.12.3

## 0.12.2

## 0.12.1

### Patch Changes

- [#231](https://github.com/aio-proxy/aio-proxy/pull/231) [`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6) Thanks [@baranwang](https://github.com/baranwang)! - dashboard: grade traces latency like new-api and show the lightning icon for fast/priority requests

  Chat Completions `service_tier` now maps onto the speed routing axis (`priority`/`fast` → fast, `flex` → flex), matching Responses.

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks [@baranwang](https://github.com/baranwang)! - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`. The removed `providers.<id>.metadata` field is silently ignored, and metadata keys no longer create routes; expose models through `providers.<id>.models` or `alias`. Metadata editing now lives in the Dashboard routing drawer instead of the Provider editor.

  Rename the plugin SDK's free-form `ModelDescriptor.metadata`, `ModelCatalog.metadata`, and raw-resolver `metadata` input to `extra`, and add typed `ModelDescriptor.modelMetadata` for host-consumed model metadata. Publish `@aio-proxy/types` as the SDK metadata type source.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks [@baranwang](https://github.com/baranwang)! - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.

## 0.11.2

## 0.11.1

## 0.11.0

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks [@baranwang](https://github.com/baranwang)! - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

- [#202](https://github.com/aio-proxy/aio-proxy/pull/202) [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1) Thanks [@baranwang](https://github.com/baranwang)! - dashboard: edit model routing in a drawer by dragging priority tiers and traffic weights

## 0.9.1

## 0.9.0

### Minor Changes

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

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b71e13c`](https://github.com/aio-proxy/aio-proxy/commit/b71e13c8c991d3482a5446fdbd980ffc37a73ae1) Thanks [@baranwang](https://github.com/baranwang)! - Align the model metadata drawer with the editor demo. Visual-tab labels are prose
  again (reasoning, context window, cache read, and so on) instead of config key
  paths, and the JSON tab names a schema field when the draft is an object Zod
  rejects instead of claiming it is not JSON. A failed models.dev slug catalog
  response now surfaces as an error with Retry, rather than an empty catalog.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`21883d3`](https://github.com/aio-proxy/aio-proxy/commit/21883d33ab3ceb0081e123aaa985f42b4622f33d) Thanks [@baranwang](https://github.com/baranwang)! - Clear up the wording around testing a provider in the Dashboard's provider editor. Testing a model now
  reports which model succeeded, so trying two models in a row no longer leaves an unlabelled green line that
  could refer to either, and the panel now calls what it sends a model request throughout — both the button
  and the line reporting a failure, which previously described it as a connection test even though the
  connection settings above have already been checked by that point. A failed test still says the provider can
  be saved anyway. When you sign in to a provider, the control that picks which product you are signing in to
  now asks for a sign-in method instead of an "OAuth provider", which read as if it were asking again about
  the provider you were editing.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ebaeb73`](https://github.com/aio-proxy/aio-proxy/commit/ebaeb73a04968dcb97a435a4037394a08e831a00) Thanks [@baranwang](https://github.com/baranwang)! - Give Dashboard OAuth loopback a styled completion page with a close button, and lock the plugin account form as soon as authorization starts.

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

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c73de2d`](https://github.com/aio-proxy/aio-proxy/commit/c73de2d1bd7c849a239d8e6a3fe139f7b6be4da6) Thanks [@baranwang](https://github.com/baranwang)! - Align the provider editor's right rail with the prototype. The model-test controls
  disappear when nothing is testable instead of leaving a disabled full-width button,
  the visible "Model to test" label becomes an accessible name only, and a pending
  test keeps the same button copy with a spinner instead of swapping in a second
  string. The exposure panel title is "Model list", its empty state says which names
  will appear, and a disabled provider folds that reason into the same sentence.

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

## 0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

## 0.6.4

## 0.6.3

## 0.6.2

## 0.6.1

### Patch Changes

- [#138](https://github.com/aio-proxy/aio-proxy/pull/138) [`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7) Thanks [@baranwang](https://github.com/baranwang)! - Add the Rspress documentation site and its shared UI foundation.

## 0.6.0

## 0.5.2

### Patch Changes

- [#133](https://github.com/aio-proxy/aio-proxy/pull/133) [`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95) Thanks [@baranwang](https://github.com/baranwang)! - Fix Docker release build failure by building `@aio-proxy/i18n` with rslib

  The `@aio-proxy/i18n` package built its declarations with `tsc -b`, unlike every other referenced workspace package (which use rslib). Because `paraglide-js compile` regenerates `src/paraglide/**` on every build, fresh/concurrent builds (such as the multi-arch Docker release) could see i18n's emitted `dist` as stale relative to its regenerated sources, so `@aio-proxy/core`'s declaration generation failed the composite project-reference check with `TS6305: Output file '.../i18n/dist/index.d.ts' has not been built from source file '.../i18n/src/index.ts'`.

  i18n now compiles messages and then builds with rslib like the other packages, emitting its declarations through the same pipeline and eliminating the fragile cross-package staleness check.

## 0.5.1

## 0.5.0

## 0.4.0

### Minor Changes

- [#124](https://github.com/aio-proxy/aio-proxy/pull/124) [`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282) Thanks [@baranwang](https://github.com/baranwang)! - i18n: restructure message keys into nested namespaces and add Traditional Chinese (zh-Hant), Japanese (ja), and Korean (ko) locales

  - Flat `cli_*`/`common_*`/`error_*`/`wizard_*` keys are now nested, dot-layered namespaces (e.g. `cli.provider.login.unknown_vendor`); dashboard/oauth/brand keys are regrouped under the same scheme.
  - Added `zh-Hant`, `ja`, and `ko` locales; `resolveLocale` now maps `zh-hant`/`zh-tw`/`zh-hk`/`zh-mo`, `ja`/`ja-*`, and `ko`/`ko-*` tags to them.
  - Removed keys that did not need translation (protocol acronyms, `N/A`, `API Key`, and similar) and inlined them at their call sites.
  - Stripped trailing sentence periods from all message values across every locale.

## 0.3.0

## 0.2.1

## 0.2.0
