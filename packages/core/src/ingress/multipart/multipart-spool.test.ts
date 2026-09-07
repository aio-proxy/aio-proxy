import { expect, test } from 'bun:test';

import { RequestBodyTooLargeError } from '../../protocol/request';
import { acquireMultipartSlot, spoolMultipartBody } from './multipart-spool';

function bodyRequest(bytes: Uint8Array): Request {
  return new Request('https://x/v1/anything', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=b' },
    body: bytes,
  });
}

test('spools no more than the cap the caller passed, not the process-wide one', async () => {
  await expect(
    spoolMultipartBody(bodyRequest(new Uint8Array(2_048)), 30_000, 'aio-proxy-test', 1_024),
  ).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  // The same body under the default ceiling still spools, so the rejection came
  // from the caller's cap rather than from anything about the body itself.
  const spool = await spoolMultipartBody(bodyRequest(new Uint8Array(2_048)), 30_000, 'aio-proxy-test');
  await spool.unlink();
});

test('a double release cannot raise the effective parse concurrency', async () => {
  const first = await acquireMultipartSlot();
  const second = await acquireMultipartSlot();
  first();
  first();

  // One slot is free, so this takes it and the cap is reached again. A leaked
  // slot from the repeated release would leave room and resolve `overflow` too.
  const third = await acquireMultipartSlot();
  let overflowed = false;
  const overflow = acquireMultipartSlot().then((release) => {
    overflowed = true;
    return release;
  });
  await Bun.sleep(5);
  expect(overflowed).toBe(false);

  second();
  const overflowRelease = await overflow;
  third();
  overflowRelease();
});
