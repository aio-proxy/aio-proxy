import { acquireProcessFileLock, type ProcessFileLock } from '@aio-proxy/core';

import type { CodexLocation } from '../contracts';
import { ensureManagedRoot } from './storage';

export type CodexLease = ProcessFileLock;

export async function withCodexInstallation<T>(
  location: CodexLocation,
  signal: AbortSignal,
  operation: (lease: CodexLease) => Promise<T>,
): Promise<T> {
  await ensureManagedRoot(location);
  const lease = await acquireProcessFileLock(`${location.home}/.aio-proxy.lock`, signal);
  try {
    return await lease.withOwnership(async () => operation(lease));
  } finally {
    await lease.release();
  }
}
