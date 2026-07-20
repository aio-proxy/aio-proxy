# Dashboard Login Brand Design

## Goal

Reuse the Dashboard sidebar's AIO Proxy brand identity on the login page and give the login page the same gray background as the authenticated console.

## Design

- Extract the existing AIO logo, `Proxy` wordmark, and localized tagline from `SideMenu` into one Dashboard component.
- Keep the component independent of sidebar primitives so it can render in both the sidebar header and login card.
- Let each consumer own its surrounding margin and placement.
- Replace the login card's plain brand-name text with the shared brand component.
- Change only the login page background from `bg-background` to the console's `bg-sidebar` token.

## Behavior

Authentication, form submission, validation, errors, loading state, navigation, and sidebar menu behavior remain unchanged. The component uses the existing logo markup and existing localized tagline, so no new copy or API behavior is introduced.

## Verification

- Add a focused component check that protects the shared brand rendering contract.
- Keep the existing login form behavior tests passing.
- Run Dashboard unit tests and package checks, then the repository preflight before completion.
