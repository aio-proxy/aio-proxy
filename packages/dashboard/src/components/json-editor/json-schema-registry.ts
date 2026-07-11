import type { Monaco } from "@monaco-editor/react";
import type { JsonSchema } from "./json-editor-state";

export type JsonSchemaRegistration = {
  readonly uri: string;
  readonly fileMatch: readonly string[];
  readonly schema: JsonSchema;
};

type MonacoWithJsonDefaults = Monaco & {
  readonly json: {
    readonly jsonDefaults: {
      setDiagnosticsOptions(options: {
        readonly validate: boolean;
        readonly allowComments: boolean;
        readonly trailingCommas: "error";
        readonly schemas: readonly JsonSchemaRegistration[];
      }): void;
    };
  };
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

let activeMonaco: Monaco | undefined;

const globalRegistry = createJsonSchemaRegistry((schemas) => {
  if (!activeMonaco) return;
  (activeMonaco as MonacoWithJsonDefaults).json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    trailingCommas: "error",
    schemas: schemas.map(({ fileMatch, ...registration }) => ({
      ...registration,
      fileMatch: [...fileMatch],
    })),
  });
});

export const registerJsonSchema = (monaco: Monaco, key: string, registration: JsonSchemaRegistration) => {
  activeMonaco = monaco;
  return globalRegistry.set(key, registration);
};
