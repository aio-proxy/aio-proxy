import { ANTIGRAVITY_DAILY, ANTIGRAVITY_SANDBOX } from '../oauth/constants';
import type { GoogleAntigravityAccountOptions } from '../schema';
import { normalizeBaseURL } from '../schema';

export type AntigravityOperation = 'project-load' | 'onboarding' | 'discovery' | 'inference' | 'count';

export function antigravityEndpoints(
  options: GoogleAntigravityAccountOptions,
  operation: AntigravityOperation,
  lastGood?: string,
): readonly string[] {
  const custom = normalizeBaseURL(options.baseURL);
  if (custom !== undefined) return [custom];
  if (operation === 'project-load' || operation === 'onboarding') return [ANTIGRAVITY_DAILY];
  const defaults = [ANTIGRAVITY_DAILY, ANTIGRAVITY_SANDBOX];
  if (lastGood !== undefined && defaults.includes(lastGood)) {
    return [lastGood, ...defaults.filter((endpoint) => endpoint !== lastGood)];
  }
  return defaults;
}
