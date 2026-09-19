const storageKey = 'aio-proxy.dashboard-session';

export function readDashboardAuthToken(): string | undefined {
  try {
    const token = globalThis.localStorage.getItem(storageKey);
    if (token !== null && token !== '') {
      discardLegacySessionToken();
      return token;
    }
    return adoptLegacySessionToken();
  } catch {
    return undefined;
  }
}

/**
 * Sessions that predate the move to `localStorage` hold their token in `sessionStorage` under the
 * same key. An unchanged key does not migrate them by itself — the two are separate storage areas —
 * so without this the very upgrade that makes logins survive a restart would log everyone out once.
 * Safe to delete once no open tab can still be running the previous build.
 */
function adoptLegacySessionToken(): string | undefined {
  try {
    const legacy = globalThis.sessionStorage.getItem(storageKey);
    if (legacy === null || legacy === '') return undefined;
    globalThis.sessionStorage.removeItem(storageKey);
    globalThis.localStorage.setItem(storageKey, legacy);
    return legacy;
  } catch {
    return undefined;
  }
}

export function writeDashboardAuthToken(token: string): void {
  try {
    globalThis.localStorage.setItem(storageKey, token);
  } catch {}
}

export function clearDashboardAuthToken(): void {
  try {
    globalThis.localStorage.removeItem(storageKey);
  } catch {}
  discardLegacySessionToken();
}

/**
 * Retire this tab's legacy copy whenever it is not the token in use. Logout removes only the shared
 * one, and nothing can reach another tab's `sessionStorage`, so a copy left behind here would be
 * adopted on the next reload and re-authenticate every tab — logout is client-side only, so a
 * retained token is still a valid one. Both reading and clearing retire it, so one run of this build
 * per tab is enough.
 */
function discardLegacySessionToken(): void {
  try {
    if (globalThis.sessionStorage.getItem(storageKey) !== null) globalThis.sessionStorage.removeItem(storageKey);
  } catch {}
}

/**
 * Fires when another tab removes the session token. `storage` never fires on the document that made
 * the change, so this is purely a cross-tab signal. Subscribers must not react to a `newValue` —
 * that is a renewal written by a sibling tab, not a logout. A wholesale `localStorage.clear()`
 * arrives with a null key, which counts as a clear too.
 *
 * Register once at module load: there is no unsubscribe, so every call adds a permanent listener.
 */
export function subscribeDashboardAuthTokenCleared(handler: () => void): void {
  globalThis.addEventListener('storage', (event: StorageEvent) => {
    if ((event.key === null || event.key === storageKey) && event.newValue === null) handler();
  });
}
