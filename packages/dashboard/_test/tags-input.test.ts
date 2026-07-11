import { describe, expect, test } from "bun:test";

const dashboardSource = `${import.meta.dir}/../src`;
const tagsInputPath = `${dashboardSource}/components/tags-input.tsx`;
const oldTagsInputPath = `${dashboardSource}/components/ui/tags-input.tsx`;

describe("tags input component", () => {
  test("lives outside the shadcn directory and supports configurable token separators", async () => {
    expect(await Bun.file(tagsInputPath).exists()).toBe(true);
    expect(await Bun.file(oldTagsInputPath).exists()).toBe(false);

    const source = await Bun.file(tagsInputPath).text();
    expect(source).toContain("tokenSeparators?: readonly string[];");
    expect(source).toContain('tokenSeparators = [",", "\\n"]');
    expect(source).toContain("splitByTokenSeparators(text, tokenSeparators)");
  });

  test("protects shadcn components from manual edits", async () => {
    const instructions = await Bun.file(`${dashboardSource}/components/ui/AGENTS.md`).text();

    expect(instructions).toContain("must not be modified manually");
    expect(instructions).toContain("bunx --bun shadcn@latest add <component> --overwrite");
  });

  test("provider forms import the migrated component", async () => {
    const providerComponents = [
      `${dashboardSource}/modules/providers/components/provider-form-fields-api.tsx`,
      `${dashboardSource}/modules/providers/components/provider-form-fields-ai-sdk.tsx`,
    ];

    for (const path of providerComponents) {
      expect(await Bun.file(path).text()).toContain('from "@/components/tags-input"');
    }
  });
});
