import type { DashboardAuthentication } from "./dashboard-auth";

export const disabledDashboardAuthentication: DashboardAuthentication = {
  available: () => true,
  enabled: () => false,
  login: async () => ({ status: "disabled" }),
  verify: () => false,
};

export const loopbackServer = { requestIP: () => ({ address: "127.0.0.1" }) };
