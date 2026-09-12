import { expect, test } from 'bun:test';

import { retainsSharedOAuth } from '../protocol';
import { withSharedOAuthDevices } from '../test-support';

function remotePhase(f: {
  backend: { readAll: () => ReadonlyMap<string, { kind: string }> };
  objectId: string;
}): string {
  const stored = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
  if (stored?.kind !== 'present') throw new Error('missing account fixture');
  return JSON.parse(new TextDecoder().decode((stored as { value: Uint8Array }).value)).phase;
}

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
    const recovered = await f.a.recover(f.objectId, f.signal);
    expect(recovered?.generation).toBe(1);
    expect(f.repoA.oauthJournals('oauth-a')).toHaveLength(1);
    f.a.confirm(f.objectId, recovered!.lastCompletedOperationId!);
    expect(f.repoA.oauthJournals('oauth-a')).toEqual([]);
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
    const restarted = f.restartA();
    const recovered = await restarted.recover(f.objectId, f.signal);
    expect(recovered?.generation).toBe(1);
    expect(f.repoA.oauthJournals('oauth-a')).toHaveLength(1);
    restarted.confirm(f.objectId, recovered!.lastCompletedOperationId!);
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

test('a claim conflict retries after rereading a still-ready same-generation account', async () => {
  await withSharedOAuthDevices(async (f) => {
    const gate = f.backend.gateNext('compareAndSwap');
    let exchanges = 0;
    const refresh = f.a.refresh(
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
    await gate.entered;
    const session = f.backend.connect();
    try {
      const current = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
      if (current?.kind !== 'present') throw new Error('missing account fixture');
      const account = JSON.parse(new TextDecoder().decode(current.value));
      account.payload.credential = { token: 'still-ready' };
      await session.compareAndSwap(
        `s/v1/default/account/${f.objectId}`,
        current.version,
        new TextEncoder().encode(JSON.stringify(account)),
        f.signal,
      );
    } finally {
      await session.dispose();
    }
    gate.release();
    expect((await refresh).status).toBe('updated');
    expect(exchanges).toBe(1);
  });
});

test('validation failure remains quarantined during recovery', async () => {
  await withSharedOAuthDevices(async (f) => {
    const input = {
      objectId: f.objectId,
      epoch: 0,
      generation: 0,
      exchange: async () => ({ value: { bad: true } }),
      validate: async (value: unknown) => f.schema.parse(value),
    };
    await expect(f.a.refresh(input, f.signal)).rejects.toMatchObject({ code: 'unverified' });
    await expect(f.a.recover(f.objectId, f.signal)).rejects.toMatchObject({ code: 'unverified' });
    const stored = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
    expect(stored?.kind).toBe('present');
    expect(JSON.parse(new TextDecoder().decode(stored!.value)).phase).toBe('login-required');
  });
});

test('an unserializable exchange result quarantines the claim instead of stranding it', async () => {
  await withSharedOAuthDevices(async (f) => {
    const input = {
      objectId: f.objectId,
      epoch: 0,
      generation: 0,
      exchange: async () => ({ value: { token: 'new' }, metadata: { expiresAt: Number.POSITIVE_INFINITY } }),
      validate: async (value: unknown) => f.schema.parse(value),
    };
    await expect(f.a.refresh(input, f.signal)).rejects.toMatchObject({ code: 'unverified' });
    const stored = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
    // A claim left in `refreshing` blocks recovery and a fresh login on every device forever.
    expect(JSON.parse(new TextDecoder().decode(stored!.value)).phase).toBe('login-required');
    expect((await f.a.recover(f.objectId, f.signal))?.phase).toBe('login-required');
  });
});

test('a journal failure before exchange leaves the account unclaimed', async () => {
  await withSharedOAuthDevices(async (f) => {
    const original = f.repoA.writeOAuthJournal;
    f.repoA.writeOAuthJournal = () => {
      throw new Error('database unavailable');
    };
    let exchanges = 0;
    try {
      await expect(
        f.a.refresh(
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
        ),
      ).rejects.toMatchObject({ code: 'refresh-deferred' });
    } finally {
      f.repoA.writeOAuthJournal = original;
    }
    expect(exchanges).toBe(0);
    const stored = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
    expect(JSON.parse(new TextDecoder().decode(stored!.value)).phase).toBe('ready');
  });
});

test('validation failure before claim leaves the account and journal untouched', async () => {
  await withSharedOAuthDevices(async (f) => {
    let exchanges = 0;
    await expect(
      f.a.refresh(
        {
          objectId: f.objectId,
          epoch: 0,
          generation: 0,
          exchange: async () => {
            exchanges++;
            return { value: { token: 'never' } };
          },
          validate: async () => {
            throw new Error('invalid current credential');
          },
        },
        f.signal,
      ),
    ).rejects.toThrow('invalid current credential');
    expect(exchanges).toBe(0);
    expect(f.repoA.oauthJournals('oauth-a')).toEqual([]);
    const stored = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
    expect(JSON.parse(new TextDecoder().decode(stored!.value)).phase).toBe('ready');
  });
});

test('a claimed account remains fenced when the remote phase never becomes ready', async () => {
  await withSharedOAuthDevices(async (f) => {
    const caller = new AbortController();
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    const refresh = f.a.refresh(
      {
        objectId: f.objectId,
        epoch: 0,
        generation: 0,
        exchange: async (_current, signal) => {
          exchangeStarted();
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('process exited')), { once: true });
          });
          throw new Error('unreachable');
        },
        validate: async (value: unknown) => f.schema.parse(value),
      },
      caller.signal,
    );
    await started;
    await expect(
      f.b.refresh(
        {
          objectId: f.objectId,
          epoch: 0,
          generation: 0,
          exchange: async () => ({ value: { token: 'replay' } }),
          validate: async (value: unknown) => f.schema.parse(value),
        },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: 'refresh-deferred' });
    await expect(f.a.recover(f.objectId, f.signal)).rejects.toMatchObject({ code: 'result-uncertain' });
    caller.abort();
    await expect(refresh).rejects.toMatchObject({ code: 'result-uncertain' });
  });
});

test('a late exchange result is journaled and recovered after caller timeout', async () => {
  await withSharedOAuthDevices(async (f) => {
    const caller = new AbortController();
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    const refresh = f.a.refresh(
      {
        objectId: f.objectId,
        epoch: 0,
        generation: 0,
        exchange: async () => {
          exchangeStarted();
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { value: { token: 'late' } };
        },
        validate: async (value: unknown) => f.schema.parse(value),
      },
      caller.signal,
    );
    await started;
    caller.abort();
    await expect(refresh).rejects.toBeInstanceOf(Error);
    expect(f.repoA.oauthJournals('oauth-a')[0]?.phase).toBe('result');
    const recovered = await f.restartA().recover(f.objectId, f.signal);
    expect(recovered?.payload.credential).toEqual({ token: 'late' });
  });
});

test('recovery fences a refreshing claim whose terminal transition never landed', async () => {
  await withSharedOAuthDevices(async (f) => {
    const input = {
      objectId: f.objectId,
      epoch: 0,
      generation: 0,
      exchange: async () => {
        // The outage that kills the exchange also kills the fence that should follow it.
        f.backend.failNext('compareAndSwap', 'before');
        throw new Error('network outage');
      },
      validate: async (value: unknown) => f.schema.parse(value),
    };
    await expect(f.a.refresh(input, f.signal)).rejects.toMatchObject({ code: 'result-uncertain' });
    expect((await f.b.recover(f.objectId, f.signal))?.phase).toBe('refreshing');
    await expect(f.a.recover(f.objectId, f.signal)).rejects.toMatchObject({ code: 'result-uncertain' });
    // The retried fence is what lets a fresh login take the Provider over again.
    expect((await f.b.recover(f.objectId, f.signal))?.phase).toBe('uncertain');
    expect((await f.a.recover(f.objectId, f.signal))?.phase).toBe('uncertain');
    expect(f.repoA.oauthJournals('oauth-a')).toEqual([]);
  });
});

test('a journal failure whose claim release is also lost still allows a later refresh', async () => {
  await withSharedOAuthDevices(async (f) => {
    let phaseAtJournalWrite: string | undefined;
    const original = f.repoA.writeOAuthJournal;
    let attempts = 0;
    f.repoA.writeOAuthJournal = (bindingId, row) => {
      attempts++;
      if (attempts > 1) {
        original.call(f.repoA, bindingId, row);
        return;
      }
      phaseAtJournalWrite = remotePhase(f);
      // Under a claim-before-journal ordering the claim is already published here, so make its
      // best-effort release fail too — that is the outage that strands the account permanently.
      if (phaseAtJournalWrite === 'refreshing') f.backend.failNext('compareAndSwap', 'before');
      throw new Error('database unavailable');
    };
    const input = {
      objectId: f.objectId,
      epoch: 0,
      generation: 0,
      exchange: async () => ({ value: { token: 'new' } }),
      validate: async (value: unknown) => f.schema.parse(value),
    };
    await expect(f.a.refresh(input, f.signal)).rejects.toMatchObject({ code: 'refresh-deferred' });
    // Durable local evidence has to exist before the remote claim, or nothing can fence it later.
    expect(phaseAtJournalWrite).toBe('ready');
    expect(remotePhase(f)).toBe('ready');
    // The stranded claim used to block every later refresh and fresh login forever.
    const retried = await f.a.refresh(input, f.signal);
    expect(retried.status).toBe('updated');
    expect(retried.account.generation).toBe(1);
  });
});

test('recovery discards a started journal superseded by a newer login epoch', async () => {
  await withSharedOAuthDevices(async (f) => {
    await expect(
      f.a.refresh(
        {
          objectId: f.objectId,
          epoch: 0,
          generation: 0,
          exchange: async () => {
            throw new Error('network timeout');
          },
          validate: async (value: unknown) => f.schema.parse(value),
        },
        f.signal,
      ),
    ).rejects.toMatchObject({ code: 'result-uncertain' });
    expect(f.repoA.oauthJournals('oauth-a')[0]?.phase).toBe('started');
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
    expect((await f.a.recover(f.objectId, f.signal))?.epoch).toBe(1);
    // A retained journal reads as shared ownership, which failed disconnect and replacement forever.
    expect(retainsSharedOAuth({ objectId: f.objectId }, f.repoA.oauthJournals('oauth-a'))).toBe(false);
  });
});
