# Dashboard Session Persistence Design

## Goal

Stop asking Dashboard users to retype `server.password` on every new browser tab and every browser
restart. Persist the existing signed session token across tabs and restarts, and renew it while the
user stays active, so an active user never has to log in again.

## Background

`2026-08-11-dashboard-bearer-auth-design.md` moved Dashboard authentication from an HTTP-only Cookie
to a signed Bearer token stored in `sessionStorage`. That spec framed "closing the tab clears the
browser copy" as a feature, but gave no security argument against persistent storage; its only
storage non-goal was keeping the plaintext password out of the browser, which holds for any storage
backend.

The result is a lifetime mismatch. The server signs a seven-day token, while the browser keeps it for
the lifetime of one tab. Because `sessionStorage` is scoped per browsing context, opening the
Dashboard in a second tab prompts for the password again even though the first tab holds a valid
session. Persisting the token does not widen the authority the server already granted.

A second, smaller problem survives any storage change: the seven-day window is absolute, not
activity-based, so a user who opens the Dashboard daily is still logged out every week.

### Threat model

XSS against the Dashboard is already decisive under the current design. An attacker executing script
in the Dashboard origin can call every authenticated control-plane endpoint from the live tab,
including the config endpoint that discloses provider credentials. Persistent storage adds the
ability to exfiltrate a token for later reuse elsewhere — a real but incremental loss against that
existing exposure.

Two alternatives were considered and rejected:

- **A "remember me" checkbox** defaulting off for non-loopback deployments. The users asking for this
  will check the box, so the security benefit is largely psychological, while the cost — two storage
  paths, a new login control, and a new field on `GET /session` — is real.
- **Returning to an HTTP-only Cookie**, which XSS cannot read. This reverses the CSRF-elimination
  decision made in the bearer-auth design one month earlier, requires rebuilding CSRF middleware for
  every `/dashboard/api/*` write (today it exists only on the passwordless path), and needs
  `SameSite` validation against the `/oauth/complete` redirect. Too much cost to defend against an
  attack that is already fatal here.

Hardening remote deployments against XSS is a separate concern, and the right investment there is a
Content Security Policy that prevents script injection, not a shorter browser storage lifetime.

## Behavior

- A successful login persists the session token so it survives new tabs and browser restarts.
- Any authenticated `/dashboard/api/*` response may carry a renewed token, which the Dashboard stores
  in place of the old one.
- `SESSION_TTL_MS` keeps its seven-day value but changes meaning, from "expires seven days after
  login" to "expires after seven days of inactivity". A user active at least once a week is never
  logged out; a user away longer than that logs in again.
- Logging out in one tab logs out every other tab.
- Changing `server.password` still invalidates every session on every device. It remains the only
  revocation mechanism, and renewal must not circumvent it.

## Server

`packages/server/src/dashboard-auth/dashboard-auth.ts` gains one method on
`DashboardAuthentication`:

```ts
readonly refresh: (token: string) => string | undefined;
```

It returns a freshly signed token when the argument passes every check `verify` applies — shape,
`v1` prefix, unexpired, signature match under the current password hash — and is older than
`REFRESH_AFTER_MS` (one day). It returns `undefined` in every other case. Token age needs no stored
state: `expiresAt` is encoded in the token, so `age = SESSION_TTL_MS - (expiresAt - now)`.

Renewed tokens are structurally identical to minted ones (`v1.<expiresAt>.<uuid>.<signature>`, signed
with the password hash), so the scheme stays stateless and password changes keep invalidating
everything.

`packages/server/src/dashboard-auth/routes.ts` gains a postflight middleware that leaves the existing
`bearerAuth` composition untouched:

```ts
export const attachDashboardSessionRefresh =
  (auth: DashboardAuthentication): MiddlewareHandler =>
  async (context, next) => {
    await next();
    const token = dashboardSessionToken(context);
    if (token === undefined) return;
    const renewed = auth.refresh(token);
    if (renewed !== undefined) context.header('x-dashboard-session-refresh', renewed);
  };
```

`create-routes.ts` mounts it on `/dashboard/api/*` ahead of the authentication middleware; Hono's
onion model runs the header write after authentication resolves. Unauthenticated requests reach
`refresh` with an invalid token and get `undefined`, so a rejected request carries no header.

Dashboard and API are same-origin, so the header needs no `Access-Control-Expose-Headers`.

Concurrent requests may each mint a different renewed token. All of them are independently valid
under the same signing key, and the last write wins.

`/admin/*` and the SSE events route do not participate: the former is CLI-facing, and the latter is a
long-lived stream with no response header left to write. Both benefit from renewals driven by other
requests on the same session.

When the configured password hash is invalid, `prepareDashboardConfig` strips `password` from the
config, so `passwordHash()` returns `undefined` and `refresh` fails exactly as `verify` does. This
holds by construction rather than by an explicit check, so it warrants a code comment.

## Dashboard

`packages/dashboard/src/lib/dashboard-auth-token/dashboard-auth-token.ts` switches from
`sessionStorage` to `localStorage`, keeping the `aio-proxy.dashboard-session` key, and adds:

```ts
export function subscribeDashboardAuthTokenCleared(handler: () => void): void;
```

It listens for `storage` events and invokes the handler when that key is removed, which keeps the
storage key private to the module.

`packages/dashboard/src/lib/dashboard-client/dashboard-client.ts` reads the renewal header in
`dashboardFetch`:

```ts
const renewed = response.headers.get('x-dashboard-session-refresh');
if (renewed !== null && renewed !== '' && readDashboardAuthToken() !== undefined) {
  writeDashboardAuthToken(renewed);
}
```

The `readDashboardAuthToken() !== undefined` guard is required, not defensive padding. Without it, a
renewal header arriving after the user logs out mid-flight would rewrite the token that
`clearDashboardAuthToken()` just removed and resurrect the session.

`packages/dashboard/src/modules/auth/services/auth-service.ts` registers cross-tab logout alongside
its existing handlers:

```ts
subscribeDashboardAuthTokenCleared(() => void logoutDashboard());
```

This repairs a defect introduced by this change rather than adding a feature. Under `sessionStorage`
tabs were isolated; under `localStorage`, a tab whose sibling logged out would keep rendering the
authenticated UI while every request returns 401. It routes through `logoutDashboard()` instead of
`markDashboardSessionExpired()` because the latter renders a "session expired" notice, which is the
wrong message for a deliberate logout.

## Scope

- `refresh` on `DashboardAuthentication`, plus the `attachDashboardSessionRefresh` middleware and its
  registration on `/dashboard/api/*`.
- `localStorage` persistence, the cleared-token subscription, renewal-header handling, and cross-tab
  logout in the Dashboard.
- A note in `README.zh-Hans.md` on how long a Dashboard login lasts.
- A changeset covering `aio-proxy`, `@aio-proxy/server`, and `@aio-proxy/dashboard` at `minor`.

## Non-goals

- No session list and no per-session revocation; that needs real server-side session storage.
- No new revocation mechanism. Changing `server.password` remains the only one.
- No "remember me" control and no storage behavior that varies by deployment.
- No move back to Cookies, and no new CSRF middleware on the password-enabled path.
- No Content Security Policy work.
- No cross-tab propagation of *login*. A sibling tab left on the login page is not confusing enough
  to justify the scope.

## Verification

Server tests in `dashboard-auth.test.ts`:

1. A freshly minted token is not renewed, so renewal does not churn tokens on every request.
2. A valid token older than the renewal threshold yields a new token that passes `verify` and carries
   a later `expiresAt`.
3. Expired and tampered tokens are not renewed.
4. A token minted under the previous password is not renewed after the password changes.

Case 4 is the most important of the four. It pins the one revocation mechanism this design relies on
so that renewal cannot silently defeat it during a later refactor.

Route tests: a request carrying an aged token receives the renewal header and the returned token
works on a subsequent request; a request carrying a fresh token receives no header; a 401 response
carries no header.

Dashboard tests: `dashboardFetch` replaces the stored token when the renewal header is present; a
renewal header arriving after the token was cleared does not resurrect the session; clearing the key
from another tab moves the session to `unauthenticated` without the expired notice.

Deliberately untested, per the repository's testing rules: the identity of the storage backend and
the numeric value of the TTL constants. Both are implementation literals, and the existing token
read/write/clear contract tests already cover the storage surface.

`bun run preflight` must pass.
