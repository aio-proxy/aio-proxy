import type { DashboardOAuthCapability } from '@aio-proxy/types';

export const capabilityKey = (capability: Pick<DashboardOAuthCapability, 'plugin' | 'capability'>): string =>
  `${capability.plugin}\0${capability.capability}`;
