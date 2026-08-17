import type { JsonSchema } from './json-editor-state';
import { configureJsonSchemas } from './json-language-service';

export type JsonSchemaRegistration = {
  readonly uri: string;
  readonly fileMatch: readonly string[];
  readonly schema: JsonSchema;
};

export const createJsonSchemaRegistry = (apply: (schemas: readonly JsonSchemaRegistration[]) => void) => {
  const entries = new Map<string, JsonSchemaRegistration>();

  return {
    set(key: string, registration: JsonSchemaRegistration) {
      entries.set(key, registration);
      apply([...entries.values()]);

      return () => {
        if (entries.get(key) !== registration) return;
        entries.delete(key);
        apply([...entries.values()]);
      };
    },
  };
};

const globalRegistry = createJsonSchemaRegistry(configureJsonSchemas);

export const registerJsonSchema = (key: string, registration: JsonSchemaRegistration) =>
  globalRegistry.set(key, registration);

export { validateJsonModel } from './json-language-service';
