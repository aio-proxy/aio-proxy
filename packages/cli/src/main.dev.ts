import { type CliDeps, defaultCliDeps } from './dashboard-assets';
import { main } from './main';

export const developmentCliDeps: CliDeps = {
  dashboardAssets: () => () => null,
  dashboardUrl: () => 'http://127.0.0.1:3000/dashboard/',
  agentAssetPaths: defaultCliDeps.agentAssetPaths,
};

if (import.meta.main) {
  await main(developmentCliDeps);
}
