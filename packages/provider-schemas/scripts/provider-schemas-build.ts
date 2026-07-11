import {
  type GenerateProviderSchemasOptions,
  generateProviderSchemaEntries as generateEntries,
  renderGeneratedProviderSchemas,
} from "./provider-schemas-generator";

export const generateProviderSchemaEntries = (
  options: GenerateProviderSchemasOptions,
  onDependency?: (dependency: string) => void,
) => generateEntries(options, onDependency);

export { renderGeneratedProviderSchemas };
