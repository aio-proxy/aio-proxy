import type { CliDeps } from "./dashboard-assets";

import { main } from "./main";

export const developmentCliDeps: CliDeps = {
  dashboardAssets: () => () => null,
  dashboardUrl: () => "http://127.0.0.1:3000/dashboard/",
};

if (import.meta.main) {
  await main(developmentCliDeps);
}
