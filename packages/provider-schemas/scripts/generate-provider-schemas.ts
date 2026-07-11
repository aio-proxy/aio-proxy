import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  generateProviderSchemaEntries as generateEntries,
  renderGeneratedProviderSchemas,
} from "./provider-schemas-generator";
import { providerSchemasRequire } from "./provider-schemas-require";

const generatedPath = fileURLToPath(new URL("../src/generated.ts", import.meta.url));

export const generateProviderSchemaEntries = (onDependency?: (dependency: string) => void) =>
  generateEntries((packageName) => providerSchemasRequire.resolve(packageName), onDependency);

export type { GeneratedProviderSchemaEntry, GeneratedProviderSchemas } from "./provider-schemas-generator";
export {
  compileTypeBoxModule,
  generateProviderSchemaEntry,
  renderGeneratedProviderSchemas,
} from "./provider-schemas-generator";

export const writeGeneratedProviderSchemas = async () => {
  const source = renderGeneratedProviderSchemas((await generateProviderSchemaEntries()).entries);
  const current = await readFile(generatedPath, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current !== source) await writeFile(generatedPath, source);
};

if (import.meta.main) await writeGeneratedProviderSchemas();
