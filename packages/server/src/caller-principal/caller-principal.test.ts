import { expect, test } from 'bun:test';

import { sameCallerPrincipal } from '../routes/realtime';
import { agentCallerPrincipal, ANONYMOUS_CALLER, staticKeyCallerPrincipal } from './caller-principal';

test('a static key principal is a digest, never the key itself', () => {
  const principal = staticKeyCallerPrincipal('sk-super-secret-value');

  expect(principal.kind).toBe('key');
  expect(principal.id).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(JSON.stringify(principal)).not.toContain('sk-super-secret-value');
});

// A bare digest is an offline verifier for the key, and a configured key may be as short
// as one character, so the id must not be reproducible by anyone holding a key guess.
test('a static key principal is not a bare digest an offline attacker could reproduce', () => {
  const bare = `sha256:${new Bun.CryptoHasher('sha256').update('1234').digest('hex')}`;

  expect(staticKeyCallerPrincipal('1234').id).not.toBe(bare);
});

test('the same key yields the same principal and different keys do not collide', () => {
  expect(sameCallerPrincipal(staticKeyCallerPrincipal('key-a'), staticKeyCallerPrincipal('key-a'))).toBe(true);
  expect(sameCallerPrincipal(staticKeyCallerPrincipal('key-a'), staticKeyCallerPrincipal('key-b'))).toBe(false);
});

test('an agent principal is keyed on the installation, which survives a token refresh', () => {
  expect(sameCallerPrincipal(agentCallerPrincipal('install-1'), agentCallerPrincipal('install-1'))).toBe(true);
  expect(sameCallerPrincipal(agentCallerPrincipal('install-1'), agentCallerPrincipal('install-2'))).toBe(false);
});

test('an agent and a static key never match, and anonymous matches only anonymous', () => {
  expect(sameCallerPrincipal(agentCallerPrincipal('x'), staticKeyCallerPrincipal('x'))).toBe(false);
  expect(sameCallerPrincipal(ANONYMOUS_CALLER, ANONYMOUS_CALLER)).toBe(true);
  expect(sameCallerPrincipal(ANONYMOUS_CALLER, agentCallerPrincipal('x'))).toBe(false);
});

// The ids above already differ, so that comparison holds even if the two factories agreed on
// `kind`. Isolation must survive an installation whose id happens to equal a key's digest.
test('cross-kind isolation holds when the two ids are identical', () => {
  const keyCaller = staticKeyCallerPrincipal('shared');
  const agentCaller = agentCallerPrincipal(keyCaller.id ?? '');

  expect(agentCaller.id).toBe(keyCaller.id);
  expect(sameCallerPrincipal(agentCaller, keyCaller)).toBe(false);
});

test('each factory carries its own kind tag', () => {
  expect(agentCallerPrincipal('install-1').kind).toBe('agent');
  expect(staticKeyCallerPrincipal('key-a').kind).toBe('key');
  expect(ANONYMOUS_CALLER.kind).toBe('anonymous');
});
