import { readFile } from "node:fs/promises";
import { describe, expect, test } from "@rstest/core";

describe("delete provider dialog", () => {
  test("Given delete triggers When wired Then the dialog owns open state behind an imperative ref", async () => {
    const [component, providersPage, editPage] = await Promise.all([
      readFile(new URL("./delete-provider-dialog.tsx", import.meta.url), "utf8"),
      readFile(new URL("../templates/providers-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../../routes/providers/$id.edit.tsx", import.meta.url), "utf8"),
    ]);

    expect(component).toContain("useImperativeHandle");
    expect(providersPage).toContain("deleteDialogRef.current?.open(row.original)");
    expect(editPage).toContain("deleteDialogRef.current?.open(provider)");
  });
});
