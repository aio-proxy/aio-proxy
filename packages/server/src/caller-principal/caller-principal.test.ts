import { expect, test } from 'bun:test';

import { sameCallerPrincipal } from '../routes/realtime';
import { agentCallerPrincipal, ANONYMOUS_CALLER, staticKeyCallerPrincipal } from './caller-principal';

test('a static key principal is a digest, never the key itself', () => {
  const principal = staticKeyCallerPrincipal('sk-super-secret-value');

  expect(principal.kind).toBe('key');
  expect(principal.id).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(JSON.stringify(principal)).not.toContain('sk-super-secret-value');
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
