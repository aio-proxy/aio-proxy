import { expect, test } from 'bun:test';

import { withSharedOAuthDevices } from '../test-support';

test('two devices exchange once and recover the durable result', async () => {
  await withSharedOAuthDevices(async (f) => {
    let exchanges = 0;
    const input = {
      objectId: f.objectId,
      epoch: 0,
      generation: 0,
      exchange: async () => {
        exchanges++;
        return { value: { token: 'new' } };
      },
      validate: async (value: unknown) => f.schema.parse(value),
    };
    const result = await Promise.allSettled([f.a.refresh(input, f.signal), f.b.refresh(input, f.signal)]);
    expect(exchanges).toBe(1);
    expect(result.some((item) => item.status === 'fulfilled')).toBe(true);
    expect((await f.a.recover(f.objectId, f.signal))?.generation).toBe(1);
  });
});

test('an unknown claim acknowledgement is reread before exchange', async () => {
  await withSharedOAuthDevices(async (f) => {
    f.backend.failNext('compareAndSwap', 'after');
    let exchanges = 0;
    const result = await f.a.refresh(
      {
        objectId: f.objectId,
        epoch: 0,
        generation: 0,
        exchange: async () => {
          exchanges++;
          return { value: { token: 'new' } };
        },
        validate: async (value: unknown) => f.schema.parse(value),
      },
      f.signal,
    );
    expect(exchanges).toBe(1);
    expect(result.status).toBe('updated');
    expect(result.account.generation).toBe(1);
  });
});

test('an exchange failure fences the account and cannot replay the old token', async () => {
  await withSharedOAuthDevices(async (f) => {
    const input = {
      objectId: f.objectId,
      epoch: 0,
      generation: 0,
      exchange: async () => {
        throw new Error('network timeout');
      },
      validate: async (value: unknown) => f.schema.parse(value),
    };
    await expect(f.a.refresh(input, f.signal)).rejects.toMatchObject({ code: 'result-uncertain' });
    await expect(f.b.refresh(input, f.signal)).rejects.toMatchObject({ code: 'refresh-deferred' });
    expect((await f.a.recover(f.objectId, f.signal))?.phase).toBe('uncertain');
  });
});

test('a durable result recovers after publication is unavailable', async () => {
  await withSharedOAuthDevices(async (f) => {
    const input = {
      objectId: f.objectId,
      epoch: 0,
      generation: 0,
      exchange: async () => {
        f.backend.failNext('compareAndSwap', 'before');
        return { value: { token: 'new' } };
      },
      validate: async (value: unknown) => f.schema.parse(value),
    };
    await expect(f.a.refresh(input, f.signal)).rejects.toMatchObject({ code: 'refresh-deferred' });
    expect(f.repoA.oauthJournals('oauth-a')[0]?.phase).toBe('result');
    expect((await f.a.recover(f.objectId, f.signal))?.generation).toBe(1);
    expect(f.repoA.oauthJournals('oauth-a')).toEqual([]);
  });
});

test('a journaled result cannot overwrite a later login epoch', async () => {
  await withSharedOAuthDevices(async (f) => {
    const input = {
      objectId: f.objectId,
      epoch: 0,
      generation: 0,
      exchange: async () => {
        f.backend.failNext('compareAndSwap', 'before');
        return { value: { token: 'new' } };
      },
      validate: async (value: unknown) => f.schema.parse(value),
    };
    await expect(f.a.refresh(input, f.signal)).rejects.toMatchObject({ code: 'refresh-deferred' });
    const session = f.backend.connect();
    try {
      const current = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
      if (current?.kind !== 'present') throw new Error('missing account fixture');
      const next = {
        ...JSON.parse(new TextDecoder().decode(current.value)),
        epoch: 1,
        generation: 0,
        payload: { credential: { token: 'login' }, options: {}, secrets: {}, fingerprint: 'new-login' },
        claim: null,
        phase: 'ready',
        lastCompletedOperationId: null,
      };
      await session.compareAndSwap(
        `s/v1/default/account/${f.objectId}`,
        current.version,
        new TextEncoder().encode(JSON.stringify(next)),
        f.signal,
      );
    } finally {
      await session.dispose();
    }
    expect(await f.a.recover(f.objectId, f.signal)).toBeNull();
    expect(f.repoA.oauthJournals('oauth-a')).toEqual([]);
  });
});
