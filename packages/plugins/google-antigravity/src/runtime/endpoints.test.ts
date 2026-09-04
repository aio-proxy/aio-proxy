import { expect, test } from 'bun:test';

import { ANTIGRAVITY_DAILY, ANTIGRAVITY_SANDBOX } from '../oauth/constants';
import { antigravityEndpoints } from './endpoints';

// 'quota' deliberately has no case of its own: it wants the same failover list as every other
// non-onboarding operation, so it falls through to the defaults.
test('quota falls through to the default base list', () => {
  expect(antigravityEndpoints({}, 'quota')).toEqual([ANTIGRAVITY_DAILY, ANTIGRAVITY_SANDBOX]);
  expect(antigravityEndpoints({}, 'quota')).toEqual(antigravityEndpoints({}, 'discovery'));
});

// A user who points the account at a relay must not have quota traffic leak to Google.
test('an account baseURL replaces the whole quota list', () => {
  expect(antigravityEndpoints({ baseURL: 'https://relay.example.com/' }, 'quota')).toEqual([
    'https://relay.example.com',
  ]);
});

test('a known lastGood base is tried first for quota', () => {
  expect(antigravityEndpoints({}, 'quota', ANTIGRAVITY_SANDBOX)).toEqual([ANTIGRAVITY_SANDBOX, ANTIGRAVITY_DAILY]);
});
