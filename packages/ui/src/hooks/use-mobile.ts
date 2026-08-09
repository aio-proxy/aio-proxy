import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;
const mediaQuery = () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
const subscribe = (onStoreChange: () => void) => {
  const query = mediaQuery();
  query.addEventListener('change', onStoreChange);
  return () => query.removeEventListener('change', onStoreChange);
};
const getSnapshot = () => mediaQuery().matches;
const getServerSnapshot = () => false;

export function useIsMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
