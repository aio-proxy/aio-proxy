import { describe, expect, test } from "bun:test";

const providerAliasComponents = new Bun.Glob("provider-alias-*.tsx");
const providerAliasDirectory = `${import.meta.dir}/../src/modules/providers/components/provider-alias`;

describe("provider alias components", () => {
  test("Given the alias editor overlay When composed Then it uses a responsive Base UI Drawer", async () => {
    let overlaySource: string | undefined;

    for await (const file of providerAliasComponents.scan({ cwd: providerAliasDirectory, absolute: true })) {
      const source = await Bun.file(file).text();
      if (source.includes("aliases_drawer_description")) overlaySource = source;
    }

    expect(overlaySource).toContain('from "@/components/ui/drawer"');
    expect(overlaySource).toContain('swipeDirection={isMobile ? "down" : "right"}');
  });
});
