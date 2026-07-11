import { fileURLToPath } from "node:url";
import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";
import { generateProviderSchemaEntries, renderGeneratedProviderSchemas } from "./generate-provider-schemas";

export const generatedProviderSchemasPath = fileURLToPath(new URL("../src/generated.ts", import.meta.url));

export const pluginProviderSchemas = (): RsbuildPlugin => ({
  name: "aio-proxy:provider-schemas",
  apply: "build",
  setup(api) {
    api.transform({ test: generatedProviderSchemasPath, order: "pre" }, async ({ code, addDependency }) => {
      const generated = await generateProviderSchemaEntries();
      for (const dependency of generated.dependencies) addDependency(dependency);
      const source = renderGeneratedProviderSchemas(generated.entries);
      if (code !== source) {
        throw new Error("Provider schemas are stale. Run: bun run --filter @aio-proxy/provider-schemas generate");
      }
      api.logger.info(`provider schemas: ${Object.keys(generated.entries).length} generated`);
      return source;
    });
  },
});
