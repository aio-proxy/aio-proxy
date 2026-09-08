import { expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';

import { create, fromBinary } from '@bufbuild/protobuf';

import {
  AgentClientMessageSchema,
  ExecServerMessageSchema,
  GetBlobArgsSchema,
  KvServerMessageSchema,
  SetBlobArgsSchema,
} from '../../gen/agent_pb';
import { buildExecResponses, encodeClientMessage, encodeKvResponse } from './client-messages';

const unframe = (framed: Uint8Array) => fromBinary(AgentClientMessageSchema, framed.subarray(5));
const blobKeyHex = (id: Uint8Array) => Buffer.from(id).toString('hex');

test('getBlobArgs returns the stored blob', () => {
  const blobId = new Uint8Array([9, 9, 9]);
  const store = new Map<string, Uint8Array>([[blobKeyHex(blobId), new TextEncoder().encode('DATA')]]);
  const kv = create(KvServerMessageSchema, {
    id: 3,
    message: { case: 'getBlobArgs', value: create(GetBlobArgsSchema, { blobId }) },
  });
  const client = unframe(encodeKvResponse(kv, store)!);
  expect(client.message.case).toBe('kvClientMessage');
});

test('setBlobArgs writes the store', () => {
  const store = new Map<string, Uint8Array>();
  const blobId = new Uint8Array([1, 2]);
  const kv = create(KvServerMessageSchema, {
    id: 4,
    message: { case: 'setBlobArgs', value: create(SetBlobArgsSchema, { blobId, blobData: new Uint8Array([7]) }) },
  });
  encodeKvResponse(kv, store);
  expect(store.get(blobKeyHex(blobId))).toEqual(new Uint8Array([7]));
});

test('requestContextArgs is answered with a requestContextResult exec', () => {
  const exec = create(ExecServerMessageSchema, {
    id: 1,
    execId: 'e',
    message: { case: 'requestContextArgs', value: {} },
  } as never);
  const client = unframe(encodeClientMessage(buildExecResponses(exec, [])[0]!));
  expect(client.message.case).toBe('execClientMessage');
  if (client.message.case !== 'execClientMessage') throw new Error('unreachable');
  expect(client.message.value.message.case).toBe('requestContextResult');
});
