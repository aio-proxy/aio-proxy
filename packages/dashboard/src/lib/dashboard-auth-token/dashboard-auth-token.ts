const storageKey = 'aio-proxy.dashboard-session';

export function readDashboardAuthToken(): string | undefined {
  try {
    const token = globalThis.localStorage.getItem(storageKey);
    return token === null || token === '' ? undefined : token;
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
