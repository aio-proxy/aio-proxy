import { expect, test } from 'bun:test';

import { createSingleFlight } from './single-flight';

test('single-flight shares one rotating refresh result', async () => {
  let calls = 0;
  const run = createSingleFlight(async () => {
    calls += 1;
    return 'rotated';
  });
  expect(await Promise.all([run(), run(), run()])).toEqual(['rotated', 'rotated', 'rotated']);
  expect(calls).toBe(1);
});

test('single-flight clears a rejected operation so the next call can retry', async () => {
  let calls = 0;
  const run = createSingleFlight(async () => {
    calls += 1;
    if (calls === 1) throw new Error('first');
    return 'recovered';
  });
  await expect(Promise.all([run(), run()])).rejects.toThrow('first');
  await expect(run()).resolves.toBe('recovered');
  expect(calls).toBe(2);
});
