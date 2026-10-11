import { AsyncLocalStorage } from 'node:async_hooks';

import type { UsageCaller } from '@aio-proxy/types';

const storage = new AsyncLocalStorage<UsageCaller>();
export const withUsageCaller = <T>(caller: UsageCaller, next: () => T): T => storage.run(caller, next);
export const currentUsageCaller = (): UsageCaller | undefined => storage.getStore();
