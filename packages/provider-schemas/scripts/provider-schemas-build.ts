import {
  generateProviderSchemaEntries as generateEntries,
  renderGeneratedProviderSchemas,
} from "./provider-schemas-generator";
import { providerSchemasRequire } from "./provider-schemas-require";

export const generateProviderSchemaEntries = (onDependency?: (dependency: string) => void) =>
  generateEntries((packageName) => providerSchemasRequire.resolve(packageName), onDependency);

export { renderGeneratedProviderSchemas };
