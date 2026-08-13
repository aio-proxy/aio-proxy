const storageKey = 'aio-proxy.dashboard-session';

export function readDashboardAuthToken(): string | undefined {
  try {
    const token = globalThis.sessionStorage.getItem(storageKey);
    return token === null || token === '' ? undefined : token;
  } catch {
    return undefined;
  }
}

export function writeDashboardAuthToken(token: string): void {
  try {
    globalThis.sessionStorage.setItem(storageKey, token);
  } catch {}
}

export function clearDashboardAuthToken(): void {
  try {
    globalThis.sessionStorage.removeItem(storageKey);
  } catch {}
}
