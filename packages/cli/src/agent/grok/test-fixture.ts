import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { GrokConfigureInput, GrokDeps } from './types';

export async function grokFixture() {
  const root = await mkdtemp(join(tmpdir(), 'aio-grok-'));
  const revoked: Array<{ endpoint: string; installationId: string }> = [];
  let now = Date.now();
  const deps: GrokDeps = {
    now: () => now,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    policy: async () => ({ env: {}, sources: [] }),
    revoke: async (endpoint, installationId) => {
      revoked.push({ endpoint, installationId });
      return 'revoked';
    },
  };
  const input: GrokConfigureInput = {
    root,
    endpoint: 'http://127.0.0.1:9317',
    executable: '/opt/bin/aio-proxy',
    adapterVersion: '0.21.0',
  };
  return {
    root,
    deps,
    input,
    revoked,
    setNow: (value: number) => {
      now = value;
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
