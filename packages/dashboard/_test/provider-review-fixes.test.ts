import { describe, expect, test } from "bun:test";

const providersModule = `${import.meta.dir}/../src/modules/providers`;

describe("provider review fixes", () => {
  test("Given invalid options JSON When the form is rendered Then submission is gated by JSON validity", async () => {
    const fields = await Bun.file(`${providersModule}/components/provider-options-textarea.tsx`).text();
    const page = await Bun.file(`${providersModule}/templates/provider-form-page.tsx`).text();

    expect(fields).toContain("onOptionsValidityChange(false)");
    expect(page).toContain("optionsJsonValid");
    expect(page).toContain("if (!optionsJsonValid)");
    expect(page).toContain("disabled={!optionsJsonValid || isPending}");
  });

  test("Given a paginated providers table When rendered Then users can navigate between pages", async () => {
    const page = await Bun.file(`${providersModule}/templates/providers-page.tsx`).text();
    const sidebar = await Bun.file(`${import.meta.dir}/../src/components/ui/sidebar.tsx`).text();

    expect(page).toContain("table.previousPage()");
    expect(page).toContain("table.nextPage()");
    expect(page).toContain("table.getPageCount()");
    expect(sidebar).toContain('"relative flex min-w-0 w-full flex-1 flex-col bg-background');
  });

  test("Given edit loading and missing states When rendered Then all fallback copy uses i18n", async () => {
    const route = await Bun.file(`${import.meta.dir}/../src/routes/providers/$id.edit.tsx`).text();

    expect(route).not.toContain("Loading...");
    expect(route).not.toContain(">Not Found<");
    expect(route).toContain('m["dashboard.providers.edit_loading"]()');
    expect(route).toContain('m["dashboard.providers.edit_not_found"]()');
  });
});
