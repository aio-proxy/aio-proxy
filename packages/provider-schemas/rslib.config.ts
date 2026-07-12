import { defineLibraryConfig } from "@aio-proxy/infra/rslib";
import { pluginProviderSchemas } from "./scripts/provider-schemas-plugin";

export const PROVIDER_SCHEMAS_BUILD_EXTERNALS = {
  "node:crypto": 'var process.getBuiltinModule("node:crypto")',
  "node:fs/promises": 'var process.getBuiltinModule("node:fs/promises")',
  "node:path": 'var process.getBuiltinModule("node:path")',
};

export default defineLibraryConfig({
  plugins: [pluginProviderSchemas()],
  tools: {
    rspack: {
      // Rspack's importModule VM cannot execute its default ESM externals.
      externals: PROVIDER_SCHEMAS_BUILD_EXTERNALS,
    },
  },
});
