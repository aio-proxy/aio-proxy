import { describe, expect, test } from "bun:test";
import { devDashboardStaticDir, embeddedDashboardAssets } from "../src/dashboard-assets";

describe("devDashboardStaticDir", () => {
  test("Given built dashboard When resolving Then returns dir containing index.html", async () => {
    const dir = devDashboardStaticDir();
    expect(await Bun.file(`${dir}/index.html`).exists()).toBe(true);
  });
});

describe("embeddedDashboardAssets", () => {
  test("Given a file map When hit and miss Then serves file or returns null", async () => {
    const tmp = `${import.meta.dir}/dashboard-assets.test.ts`;
    const assets = embeddedDashboardAssets({ "index.html": tmp });
    const hit = await assets("index.html");
    expect(hit).not.toBeNull();
    expect(await hit?.text()).toContain("embeddedDashboardAssets");
    expect(await assets("missing.js")).toBeNull();
  });
});
