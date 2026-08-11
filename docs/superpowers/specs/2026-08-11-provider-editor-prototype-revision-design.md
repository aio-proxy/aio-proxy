# Provider Editor Prototype Revision

## Goal

Revise the static provider create/edit prototype so its interaction model matches the existing provider configuration and routing behavior. This pass changes only the prototype under `.reference/provider-editor`; it does not introduce a new backend or cross-provider configuration concept.

## Interaction design

### Connection and validation

The connection section configures credentials and transport only. It must not claim that API Key presence proves the provider works.

Validation happens after at least one model is enabled. The validation control selects an enabled upstream model and sends one small request. It reports pending, success, and failure states without blocking save.

### Models, metadata, and aliases

Enabled models remain the provider's upstream model catalog. Each enabled model exposes a `Metadata` action that opens a JSON drawer for optional per-model overrides such as display information, limits, capabilities, and cost.

Aliases are edited in a separate mapping area instead of inside each model row. Every row reads left-to-right as:

`client model ID -> upstream model in this provider`

One alias maps to one default upstream model in a provider. Optional reasoning variants may map to additional upstream models. The target model's original ID can optionally remain exposed. Routing one client model ID across several providers still requires that alias on each relevant provider; that cross-provider workflow is outside this prototype revision.

### Request rewriting

Request rewriting keeps the existing product concept: an ordered list of user-authored rules applied before the request is sent upstream. The prototype provides visual and JSON modes and supports adding, removing, and reordering representative rules. It must not present a catalog of predefined transformations.

### Placement

- `Connection`: protocol, URL, credentials, authorization, package options.
- `Models`: catalog selection, per-model metadata, alias mappings, model validation.
- `Routing`: enabled state and provider weight.
- `Advanced`: proxy, headers, and the existing request-rewrite editor.

## State and verification

Prototype-only state remains local and deterministic. Fake async tasks simulate catalog loading, authorization, and model validation. The revision is complete when the prototype builds, the four corrected interactions work in the browser, and the existing `react-grab` import still identifies selected components and source locations.

