import { describe, expect, test } from "bun:test";

const componentPath = `${import.meta.dir}/../src/modules/providers/components/delete-provider-dialog.tsx`;
const providersPagePath = `${import.meta.dir}/../src/modules/providers/templates/providers-page.tsx`;
const editPagePath = `${import.meta.dir}/../src/routes/providers/$id.edit.tsx`;

describe("delete provider dialog", () => {
  test("Given delete triggers When wired Then the dialog owns open state behind an imperative ref", async () => {
    const [component, providersPage, editPage] = await Promise.all([
      Bun.file(componentPath).text(),
      Bun.file(providersPagePath).text(),
      Bun.file(editPagePath).text(),
    ]);

    expect(component).toContain("useImperativeHandle");
    expect(providersPage).toContain("deleteDialogRef.current?.open(row.original)");
    expect(editPage).toContain("deleteDialogRef.current?.open(provider)");
  });
});
