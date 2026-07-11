import { join } from "node:path";
import type { RsbuildPlugin } from "@aio-proxy/infra/rslib";
import type * as ProviderSchemasGenerator from "./provider-schemas-build";

export const pluginProviderSchemas = (): RsbuildPlugin => ({
  name: "aio-proxy:provider-schemas",
  apply: "build",
  setup(api) {
    const generatedProviderSchemasPath = join(api.context.rootPath, "src/schema-module.ts");
    const providerSchemasGeneratorPath = join(api.context.rootPath, "scripts/provider-schemas-build.ts");
    api.transform({ test: generatedProviderSchemasPath, order: "pre" }, async ({ addDependency, importModule }) => {
      const { generateProviderSchemaEntries, renderGeneratedProviderSchemas } =
        await importModule<typeof ProviderSchemasGenerator>(providerSchemasGeneratorPath);
      const generated = await generateProviderSchemaEntries(addDependency);
      const source = renderGeneratedProviderSchemas(generated.entries);
      api.logger.info(`provider schemas: ${Object.keys(generated.entries).length} generated`);
      return source;
    });
  },
});
