import { expect, test } from 'bun:test';

import type { SyncCAS, SyncRead, SyncSession } from '../sync';
import { exerciseSyncBackend } from './sync-conformance';

type Entry = Extract<SyncRead, { kind: 'present' }>;

function createFixture(): { readonly a: SyncSession; readonly b: SyncSession; readonly cleanup: () => Promise<void> } {
  const values = new Map<string, Entry>();
  let nextVersion = 0;
  let cleanupMode = false;

  function session(id: string): SyncSession {
    let disposed = false;

    function assertOpen(): void {
      if (disposed) throw new Error('session disposed');
    }

    return {
      identityId: 'test-identity',
      spaceId: 'test-space',
      maxValueBytes: Number.MAX_SAFE_INTEGER,
      async read(key): Promise<SyncRead> {
        assertOpen();
        if (cleanupMode && key.endsWith('/value')) throw new Error('fixture read failed during cleanup');
        const current = values.get(key);
        return current === undefined ? { kind: 'absent' } : { ...current, value: current.value.slice() };
      },
      async compareAndSwap(key, expected, value): Promise<SyncCAS> {
        assertOpen();
        const current = values.get(key);
        if ((current?.version ?? null) !== expected) return { kind: 'conflict' };
        const version = `v${++nextVersion}`;
        values.set(key, { kind: 'present', value: value.slice(), version, modifiedAt: 0 });
        return { kind: 'written', version, modifiedAt: 0 };
      },
      async list({ prefix, cursor }): Promise<{ keys: readonly string[]; nextCursor?: string }> {
        assertOpen();
        const keys = [...values.keys()].filter((key) => key.startsWith(prefix)).sort();
        const offset = cursor === undefined ? 0 : Number(cursor);
        const page = keys.slice(offset, offset + 2);
        const nextOffset = offset + page.length;
        return { keys: page, ...(nextOffset < keys.length ? { nextCursor: String(nextOffset) } : {}) };
      },
      async remove(key, expected): Promise<{ kind: 'removed' | 'conflict' }> {
        assertOpen();
        if (cleanupMode && key.endsWith('/list-a')) return { kind: 'conflict' };
        const current = values.get(key);
        if (current === undefined || current.version !== expected) return { kind: 'conflict' };
        values.delete(key);
        return { kind: 'removed' };
      },
      async dispose(): Promise<void> {
        disposed = true;
        if (id === 'a') cleanupMode = true;
      },
    };
  }

  return { a: session('a'), b: session('b'), async cleanup() {} };
}

test('reports every unresolved fixture key after an earlier cleanup error', async () => {
  let caught: unknown;
  try {
    await exerciseSyncBackend(async () => createFixture());
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AggregateError);
  const cleanupError =
    (caught as AggregateError).message === 'sync backend fixture cleanup failed'
      ? (caught as AggregateError)
      : (caught as AggregateError).errors.find((error): error is AggregateError => error instanceof AggregateError);
  expect(cleanupError).toBeInstanceOf(AggregateError);
  expect(cleanupError?.errors).toHaveLength(2);
  expect(cleanupError?.errors.at(-1)).toMatchObject({ message: 'sync fixture cleanup did not complete' });
});
