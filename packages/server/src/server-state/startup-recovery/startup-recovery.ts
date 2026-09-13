import type { recoverPendingAccountOperations } from '@aio-proxy/core';

import type { ServerRuntime } from '../lifecycle';
import { recoverBeforeSnapshot } from '../recovery';
import type { RecoveryScheduler } from '../types';

export function recoverBeforeInitialSnapshot(
  runtime: Pick<
    ServerRuntime,
    'configFile' | 'repository' | 'diagnostics' | 'pluginLogger' | 'queue' | 'withProviderGate' | 'tryProviderGate'
  >,
  recoverAccounts: typeof recoverPendingAccountOperations,
  scheduler: RecoveryScheduler,
) {
  return recoverBeforeSnapshot({
    configFile: runtime.configFile,
    repository: runtime.repository,
    diagnostics: runtime.diagnostics,
    logger: runtime.pluginLogger,
    recoverAccounts,
    scheduler,
    enqueue: runtime.queue,
    withProviderGate: runtime.withProviderGate,
    tryProviderGate: runtime.tryProviderGate,
  });
}
