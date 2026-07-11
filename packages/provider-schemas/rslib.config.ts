import { defineLibraryConfig } from "@aio-proxy/infra/rslib";
import { pluginProviderSchemas } from "./scripts/provider-schemas-plugin";

export default defineLibraryConfig({ plugins: [pluginProviderSchemas()] });
