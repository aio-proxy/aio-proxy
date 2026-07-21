# Provider Management Polish Design

## Goal

Make Provider management faster to scan and safer to operate without changing its underlying configuration flows. The result should feel like a restrained operational dashboard: identity is obvious, common actions are direct, and destructive or exceptional actions no longer compete with Save.

## Provider List

- Keep the existing table implementation, filtering, loading, empty, focus, and data contracts.
- Replace the current diagnostic column set with four identity-first columns:
  - **Provider**: display name, Provider ID, and kind in one cell.
  - **Status**: enabled state and current availability.
  - **Details**: OAuth account/service metadata when present; otherwise omit secondary content instead of filling the row with dashes.
  - **Models**: model count.
- Remove column visibility and client-side sorting. They add controls without helping the normal small configuration set.
- Keep the text filter with a translated placeholder that names the searchable identity fields.
- Make each editable row a clear click and keyboard affordance for editing, with a trailing chevron.
- Remove the row action menu for editable Providers. Delete moves to the edit page terminal action row, so normal rows have one unambiguous action.
- Providers whose invalid configuration has no edit route keep a visible delete action and the existing confirmation dialog; they must not become dead-end rows.
- Hide pagination when all results fit on one page. Preserve the existing pagination behavior when more than one page exists.
- Preserve focused-row scrolling and highlighting after returning from another workflow.

## Responsive List

The reduced columns must fit without horizontal clipping. On narrow screens, Provider remains the dominant two-line identity, Status and model count stay compact, optional Details is hidden, and the trailing edit affordance remains visible. No separate mobile card implementation or duplicated provider mapping is introduced.

## Edit Page Structure

- Increase the form container from the current narrow single-column width to a readable medium width.
- Keep the existing back navigation and add Provider ID and kind as secondary identity under the page title.
- `PageContainer` exposes this as an optional plain-text `subtitle`; Provider edit pages pass `Provider ID · kind`, create pages omit it, and editable content does not repeat it.
- Organize fields into quiet sections separated by spacing and dividers, not decorative cards:
  - **Basic information**: display name, enabled, and Provider weight.
  - **Connection** or **Integration**: provider-specific URL, credential, protocol, package, or OAuth connection fields.
  - **Models and aliases**: model tags plus the existing alias count and drawer entry point.
- Use two columns only for short related fields where space allows; stack everything on narrow screens.
- Keep all current validation, credential-preservation, OAuth-session, submit, and post-save navigation behavior.

## OAuth Edit Behavior

- Render immutable Provider ID, OAuth service, and connected account as read-only metadata rather than disabled form controls.
- Place Reauthorize with the OAuth connection information as a secondary operation.
- Keep alias issue validation and the existing alias drawer unchanged.
- Keep Reauthorize in Connection; place Delete at the opposite edge of the terminal action row.

## Actions and Danger Zone

- Center the edit content and use one transparent terminal action row in normal document flow.
- Place Save followed by Cancel on the left and Delete on the right; Save remains the single primary action.
- Keep the existing confirmation dialog as the destructive safeguard instead of a separate danger-zone section.
- Saving, reauthorizing, and deleting retain their current loading and disabled behavior.

## Accessibility and Copy

- Keep visible section headings and translated field labels.
- Editable rows expose native link keyboard behavior and a useful accessible name that includes Provider identity.
- Status remains understandable without color alone.
- All new labels, helper text, and placeholders use the existing i18n system.
- Focus styling continues to come from the existing shadcn/Base UI primitives and semantic tokens.

## Component Scope

- `ProvidersPage` keeps page-level data loading, new-provider selection, warning display, and focused Provider handling.
- `ProvidersTable` owns filtering, the reduced column model, row navigation, responsive visibility, and conditional pagination.
- `ProviderFormPage` and `OAuthProviderEditPage` adopt the same section hierarchy and stable action treatment while keeping their current provider-specific submit logic.
- Existing field components, alias drawer, delete dialog, table primitives, and provider protocol components are reused.
- No new dependency, shared abstraction, auto-save flow, unsaved-changes guard, or master-detail routing is introduced.

## Verification

- Add or update behavior-level tests for row navigation, keyboard activation, conditional pagination, and the order of Save, Cancel, and Delete actions.
- Preserve existing submit, OAuth session, alias validation, and focused-row regression coverage.
- Run dashboard checks and affected tests, then `bun run preflight`.
- Visually verify populated, empty, and loading list states; API/AI SDK and OAuth edit pages; action menus removed; delete dialog; alias drawer; and desktop plus narrow layouts.
