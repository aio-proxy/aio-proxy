import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type DashboardAssets, directoryDashboardAssets } from "@aio-proxy/server";

export type CliDeps = {
  readonly dashboardAssets: () => DashboardAssets;
  readonly dashboardUrl?: (apiUrl: string) => string;
};

export const devDashboardStaticDir = (): string => {
  const indexPath = fileURLToPath(import.meta.resolve("@aio-proxy/dashboard/dist/index.html"));
  if (!existsSync(indexPath)) {
    throw new Error(`Dashboard assets not found at ${indexPath}. Run \`bun run build:dashboard\` first.`);
  }
  return dirname(indexPath);
};

export const embeddedDashboardAssets =
  (files: Readonly<Record<string, string>>): DashboardAssets =>
  (path) => {
    const embedded = files[path];
    return embedded === undefined ? null : new Response(Bun.file(embedded));
  };

export const defaultCliDeps: CliDeps = {
  dashboardAssets: () => directoryDashboardAssets(devDashboardStaticDir()),
};
