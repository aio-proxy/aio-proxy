import { readFile } from "node:fs/promises";
import { describe, expect, test } from "@rstest/core";

describe("provider alias components", () => {
  test("Given the alias editor overlay When composed Then it uses a responsive Base UI Drawer", async () => {
    const overlaySource = await readFile(new URL("./provider-alias-drawer.tsx", import.meta.url), "utf8");

    expect(overlaySource).toContain('from "@/components/ui/drawer"');
    expect(overlaySource).toContain('swipeDirection={isMobile ? "down" : "right"}');
  });
});
