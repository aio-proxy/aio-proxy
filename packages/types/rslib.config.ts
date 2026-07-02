import type { RsbuildPlugin } from "@rslib/core";
import { z } from "zod";
import { defineLibraryConfig } from "../../rslib.base.ts";
import { ConfigSchema } from "./src/index.ts";

const configSchemaPlugin = (): RsbuildPlugin => ({
  name: "aio-proxy-config-schema",
  apply: "build",
  setup(api) {
    api.processAssets({ stage: "additional" }, ({ sources, compilation }) => {
      const schema = z.toJSONSchema(ConfigSchema, { io: "input" });
      compilation.emitAsset(
        "config.schema.json",
        new sources.RawSource(JSON.stringify(schema, null, 2)),
      );
    });
  },
});

export default defineLibraryConfig({
  plugins: [configSchemaPlugin()],
});
