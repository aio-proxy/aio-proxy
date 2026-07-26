import { describe, expect, test } from 'bun:test';

import { AtomicConfigFile } from '.';
import { fixture, PROCESS_CLEANUP_TEST_BUDGET_MS, PROCESS_CLEANUP_TEST_TIMEOUT_MS } from './test-support';

describe('AtomicConfigFile', () => {
  test.serial(
    'a process identity lookup that ignores termination is force-killed and bounded',
    async () => {
      const { path } = fixture('{}\n');
      const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
      const originalSpawn = mutableBun.spawn;
      const killSignals: unknown[] = [];
      mutableBun.spawn = (() => {
        const stdout = new ReadableStream<Uint8Array>({
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            return new Promise<void>(() => {});
          },
        });
        return {
          stdout,
          exited: new Promise<number>(() => {}),
          kill(signal?: unknown) {
            killSignals.push(signal);
          },
        } as unknown as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn;
      const pending = new AtomicConfigFile(path).replace((current) => current);
      try {
        await expect(
          Promise.race([
            pending,
            Bun.sleep(PROCESS_CLEANUP_TEST_BUDGET_MS).then(() => {
              throw new Error('config identity cleanup exceeded its budget');
            }),
          ]),
        ).resolves.toBeUndefined();
        expect(killSignals.length).toBeGreaterThan(0);
        expect(killSignals.every((signal) => signal === 9)).toBe(true);
      } finally {
        mutableBun.spawn = originalSpawn;
        void pending.catch(() => {});
      }
    },
    PROCESS_CLEANUP_TEST_TIMEOUT_MS,
  );

  test.serial('a released stdout reader cannot make process identity cleanup reject', async () => {
    const { path } = fixture('{}\n');
    const mutableBun = Bun as unknown as { spawn: typeof Bun.spawn };
    const originalSpawn = mutableBun.spawn;
    const killSignals: unknown[] = [];
    mutableBun.spawn = (() => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('MATCH\n'));
          controller.close();
        },
      }),
      exited: new Promise<number>(() => {}),
      kill(signal?: unknown) {
        killSignals.push(signal);
      },
    })) as unknown as typeof Bun.spawn;
    const pending = new AtomicConfigFile(path).replace((current) => current);
    try {
      await expect(
        Promise.race([
          pending,
          Bun.sleep(2_500).then(() => {
            throw new Error('config cleanup rejection exceeded its budget');
          }),
        ]),
      ).resolves.toBeUndefined();
      expect(killSignals.every((signal) => signal === 9)).toBe(true);
    } finally {
      mutableBun.spawn = originalSpawn;
      void pending.catch(() => {});
    }
  });
});
