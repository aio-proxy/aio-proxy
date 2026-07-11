import { defineLibraryConfig, type RsbuildPlugin } from "@aio-proxy/infra/rslib";
import { writeGeneratedProviderSchemas } from "./scripts/generate-provider-schemas";

const providerSchemasPlugin = (): RsbuildPlugin => ({
  name: "aio-proxy-provider-schemas",
  setup(api) {
    api.onBeforeBuild(async () => {
      await writeGeneratedProviderSchemas();
    });
  },
});

export default defineLibraryConfig({ plugins: [providerSchemasPlugin()] });
