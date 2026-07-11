import { fileURLToPath } from "node:url";
import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";
import type * as ProviderSchemasGenerator from "./provider-schemas-build";

export const generatedProviderSchemasPath = fileURLToPath(new URL("../src/generated.ts", import.meta.url));
export const providerSchemasGeneratorPath = fileURLToPath(new URL("./provider-schemas-build.ts", import.meta.url));

export const pluginProviderSchemas = (): RsbuildPlugin => ({
  name: "aio-proxy:provider-schemas",
  apply: "build",
  setup(api) {
    api.transform(
      { test: generatedProviderSchemasPath, order: "pre" },
      async ({ code, addDependency, importModule }) => {
        const { generateProviderSchemaEntries, renderGeneratedProviderSchemas } =
          await importModule<typeof ProviderSchemasGenerator>(providerSchemasGeneratorPath);
        const generated = await generateProviderSchemaEntries(addDependency);
        const source = renderGeneratedProviderSchemas(generated.entries);
        if (code !== source) {
          throw new Error("Provider schemas are stale. Run: bun run --filter @aio-proxy/provider-schemas generate");
        }
        api.logger.info(`provider schemas: ${Object.keys(generated.entries).length} generated`);
        return source;
      },
    );
  },
});
