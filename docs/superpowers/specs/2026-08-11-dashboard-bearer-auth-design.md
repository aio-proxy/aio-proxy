# Dashboard Bearer Authentication Design

## Goal

Move password-enabled Dashboard API authentication from an HTTP-only Cookie to an explicit Bearer session token stored in browser `sessionStorage`. This removes CSRF exposure for authenticated Dashboard API requests without reusing model caller API keys.

## Scope

- `server.password` remains the independent Dashboard credential.
- `POST /dashboard/api/auth/login` verifies that password and returns the existing signed, expiring Dashboard session token in JSON. It no longer writes a Cookie.
- The Dashboard stores that token in `sessionStorage` and sends `Authorization: Bearer <token>` on every Dashboard API request.
- `/dashboard/api/*` uses Hono `bearerAuth` with `dashboardAuth.verify` as its token verifier, except for the login endpoint.
- When `server.password` is configured, Dashboard API mutations rely on Bearer authentication and no longer use the Origin-based CSRF middleware.
- When no password is configured, Dashboard remains loopback-only and its mutation requests retain strict loopback Origin validation.
- `POST /admin/reload` remains loopback-only and unauthenticated for `aio-proxy reload`; it retains strict loopback Origin validation and is not converted to Bearer auth.

## Non-goals

- Do not reuse `server.apiKeys`; model caller credentials must not grant control-plane access.
- Do not put the raw Dashboard password in `sessionStorage`.
- Do not add management API keys or change CLI reload credentials.
- Do not make the server-side Dashboard event endpoint a frontend dependency.

## Flow

1. A user submits the Dashboard password to the existing login endpoint.
2. The server verifies it, creates the existing signed seven-day session token, and returns it in the JSON response.
3. The Dashboard stores the opaque token in `sessionStorage` for the current browser tab.
4. Each Dashboard API request sends `Authorization: Bearer <token>`.
5. `bearerAuth({ verifyToken: dashboardAuth.verify })` validates the token. Browser-originated requests without this explicit header cannot authenticate, so CSRF protection is unnecessary for this path.
6. Closing the tab clears the browser copy. The server still rejects expired tokens.

## Error handling and tests

- Missing or invalid Bearer token returns the standard 401 Bearer challenge.
- Password login failures and rate limiting retain their current responses.
- Cover login token return, Bearer acceptance and rejection, absence of Cookie authentication, loopback passwordless behavior, and the unchanged unauthenticated CLI reload path.
