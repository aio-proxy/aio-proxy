export { deviceFlowFetch, loginContext, withFetchMock } from '../../__tests__/test-support';

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index++) await Promise.resolve();
}

export async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
