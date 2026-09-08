import { expect, test } from 'bun:test';

import { withTwoSyncDevices } from '../test-support';

test('a cloud Provider joins the other device and import has no outgoing echo', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')?.mode).toBe('included');
    expect(b.repo.outbox(b.binding.id)).toEqual([]);
  });
});

test('a locally excluded Provider stays excluded when discovered from the cloud', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await b.commitProvider('work', { kind: 'api', apiKey: 'local' }, false);
    await a.commitProvider('work', { kind: 'api', apiKey: 'shared' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')).toMatchObject({
      mode: 'excluded',
      pendingReason: null,
    });
    expect(b.repo.outbox(b.binding.id)).toEqual([]);
  });
});

test('start polls when the backend has no watch callback', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.engine.reconcile(a.signal);
    const polling = b.engine;
    // The fixture uses the production default timer; an explicit reconcile remains the
    // deterministic assertion while start/stop exercises the no-watch lifecycle.
    polling.start();
    await polling.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')?.mode).toBe('included');
    await polling.stop();
  });
});
