import type { DashboardAuthentication } from './dashboard-auth';

export const disabledDashboardAuthentication: DashboardAuthentication = {
  available: () => true,
  enabled: () => false,
  login: async () => ({ status: 'disabled' }),
  refresh: () => undefined,
  verify: () => false,
};

export const loopbackServer = { requestIP: () => ({ address: '127.0.0.1' }) };
