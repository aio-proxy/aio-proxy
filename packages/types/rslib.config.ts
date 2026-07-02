import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RsbuildPlugin } from "@rslib/core";
import { z } from "zod";
import { defineLibraryConfig } from "../../rslib.base.ts";
import { ConfigSchema } from "./src/index.ts";

const configSchemaPlugin = (): RsbuildPlugin => ({
  name: "aio-proxy-config-schema",
  apply: "build",
  setup(api) {
    api.onAfterBuild(async ({ environments }) => {
      const [environment] = Object.values(environments);
      const outputPath = join(
        environment?.distPath ?? join(process.cwd(), "dist"),
        "config.schema.json",
      );
      const schema = z.toJSONSchema(ConfigSchema, { io: "input" });

      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`);
    });
  },
});

export default defineLibraryConfig({
  plugins: [configSchemaPlugin()],
});
