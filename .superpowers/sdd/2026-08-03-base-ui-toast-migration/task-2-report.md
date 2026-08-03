# Task 2 report: real Base toast behavior tests

## Scope

Changed tests only:

- `packages/dashboard/src/components/root-layout/root-layout-content.test.tsx`
- `packages/dashboard/src/components/side-menu/sidebar-logout.test.tsx`

The Dashboard production imports and calls remain unchanged: the authenticated root still mounts Sonner's `Toaster`, and `useDashboardLogout` still calls Sonner's `toast.error`. Sonner is mocked only as no-op plumbing in the logout test; no mock call is asserted.

## TDD contract

The authenticated-root assertion would pass after the root imports and mounts the real `Toaster` from `@aio-proxy/ui/components/toast`.

The rejected-logout assertion would pass after `useDashboardLogout` imports the real Base `toast` and calls its error API with the existing localized `Could not sign out.` copy.

Both tests use the real `Toaster` / `toast` exports for the visible behavior assertion, preserving the success and error semantics.

## RED evidence

Command:

```sh
bun run --filter @aio-proxy/dashboard test:unit -- root-layout-content.test.tsx sidebar-logout.test.tsx
```

Result: exit code 1; 5 tests total, 2 failed, 3 passed.

The new authenticated-root assertion failed at `root-layout-content.test.tsx:40`:

```text
Unable to find an element with the text: Toast ready.
```

The rendered DOM contains the authenticated sidebar and protected content but no Base UI toast portal. This is expected because the root currently renders the mocked Sonner `Toaster`, so `toast.add({ type: 'success', title: 'Toast ready' })` has no Base host.

The new logout-failure assertion failed at `sidebar-logout.test.tsx:61`:

```text
Unable to find an element with the text: Could not sign out.
```

The rendered DOM contains the real Base UI toast portal and empty viewport, proving the test setup is valid. The message is absent because the production logout hook writes to Sonner, which is deliberately mocked as a no-op while migration is incomplete.

These are behavior failures, not setup errors, and are the expected RED outcome for Task 2.
