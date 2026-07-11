import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { usageQueryOptions } from "../src/modules/usage/services/usage-service";

const dashboardRoot = join(import.meta.dir, "../src");

describe("usage overview query", () => {
  test("keys cache and polling by all selected controls", () => {
    const options = usageQueryOptions({ range: "7d", metric: "tokens", groupBy: "provider" });

    expect(options.queryKey).toEqual(["dashboard", "usage", "7d", "tokens", "provider"]);
    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  test("renders usage on the root route without a standalone usage navigation item", () => {
    const indexRoute = readFileSync(join(dashboardRoot, "routes/index.tsx"), "utf8");
    const sideMenu = readFileSync(join(dashboardRoot, "components/side-menu/side-menu.tsx"), "utf8");

    expect(indexRoute).toContain("<UsageOverview />");
    expect(existsSync(join(dashboardRoot, "routes/usage.tsx"))).toBe(false);
    expect(sideMenu).not.toContain('to: "/usage"');
  });
});
