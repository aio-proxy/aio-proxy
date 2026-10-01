import { expect, test } from 'bun:test';

import { parseSubmission } from './notary';

test('reads the final JSON object notarytool prints, after any progress lines', () => {
  const stdout =
    'Conducting pre-submission checks...\n{"id":"2efe2717-52ef-43a5-96dc-0797e4ca1041","message":"Processing complete","status":"Accepted"}\n';
  expect(parseSubmission(stdout)).toEqual({ id: '2efe2717-52ef-43a5-96dc-0797e4ca1041', status: 'Accepted' });
});

test('an Invalid submission is reported as such, so the caller can fetch its log', () => {
  expect(parseSubmission('{"id":"abc","message":"Processing complete","status":"Invalid"}').status).toBe('Invalid');
});

test('output without a JSON result, or a result without a status, is an error', () => {
  expect(() => parseSubmission('Error: HTTP status code: 401. Unable to authenticate.')).toThrow('no JSON result');
  expect(() => parseSubmission('{"id":"abc","message":"Processing complete"}')).toThrow('status');
});

test('a result pretty-printed over several lines is read whole', () => {
  const stdout = [
    'Conducting pre-submission checks for aio-proxy.zip and initiating connection to the Apple notary service...',
    'Successfully uploaded file',
    '{',
    '  "id" : "2efe2717-52ef-43a5-96dc-0797e4ca1041",',
    '  "message" : "Processing complete",',
    '  "status" : "Accepted"',
    '}',
    '',
  ].join('\n');
  expect(parseSubmission(stdout)).toEqual({ id: '2efe2717-52ef-43a5-96dc-0797e4ca1041', status: 'Accepted' });
});
