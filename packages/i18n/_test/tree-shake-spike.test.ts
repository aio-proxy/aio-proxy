import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("paraglide tree-shaking spike", () => {
  test("documents aggregated m bundle retention for unused message names", async () => {
    // Given
    const root = mkdtempSync(join(tmpdir(), "aio-i18n-spike-"));
    cpSync("packages/i18n/messages", join(root, "messages"), {
      recursive: true,
    });
    cpSync("packages/i18n/project.inlang", join(root, "project.inlang"), {
      recursive: true,
    });

    const enPath = join(root, "messages/en.json");
    const zhPath = join(root, "messages/zh-CN.json");
    const enMessages = JSON.parse(readFileSync(enPath, "utf8")) as Record<
      string,
      string
    >;
    const zhMessages = JSON.parse(readFileSync(zhPath, "utf8")) as Record<
      string,
      string
    >;

    for (let index = 1; index <= 100; index += 1) {
      const key = `spike_msg_${String(index).padStart(3, "0")}`;
      enMessages[key] = `Spike ${index}`;
      zhMessages[key] = `TODO: Spike ${index}`;
    }

    writeFileSync(enPath, `${JSON.stringify(enMessages, null, 2)}\n`);
    writeFileSync(zhPath, `${JSON.stringify(zhMessages, null, 2)}\n`);

    const compile = Bun.spawnSync(
      [
        "bunx",
        "@inlang/paraglide-js",
        "compile",
        "--project",
        "./project.inlang",
        "--outdir",
        "./paraglide",
      ],
      {
        cwd: root,
      },
    );
    expect(compile.exitCode).toBe(0);

    const entry = join(root, "entry.ts");
    const bundle = join(root, "bundle.js");
    writeFileSync(
      entry,
      'import { m } from "./paraglide/messages.js"; console.log(m.spike_msg_001());\n',
    );

    // When
    const build = Bun.spawnSync([
      "bun",
      "build",
      "--bundle",
      "--target=bun",
      "--minify",
      entry,
      "--outfile",
      bundle,
    ]);

    // Then
    expect(build.exitCode).toBe(0);
    expect(readFileSync(bundle, "utf8")).toContain("spike_msg_050");
  });
});
