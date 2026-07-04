import { join, normalize, sep } from "node:path";

export type DashboardAssets = (path: string) => Response | null | Promise<Response | null>;

export const directoryDashboardAssets =
  (dir: string): DashboardAssets =>
  async (path) => {
    const root = normalize(dir);
    const full = normalize(join(root, path));
    if (full !== root && !full.startsWith(`${root}${sep}`)) {
      return null;
    }
    const file = Bun.file(full);
    return (await file.exists()) ? new Response(file) : null;
  };
