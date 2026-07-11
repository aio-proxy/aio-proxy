import type { Monaco, OnValidate } from "@monaco-editor/react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { CodeEditor } from "@/components/code-editor";
import {
  type JsonEditorValidation,
  type JsonSchema,
  type JsonValidationMarker,
  type JsonValue,
  mergeJsonValidation,
  parseJsonDraft,
} from "./json-editor-state";
import { registerJsonSchema } from "./json-schema-registry";

export type JsonEditorProps = {
  readonly value: JsonValue | undefined;
  readonly schema?: JsonSchema;
  readonly onValueChange: (value: JsonValue | undefined) => void;
  readonly onValidationChange?: (validation: JsonEditorValidation) => void;
  readonly id?: string;
  readonly className?: string;
  readonly height?: string | number;
};

const formatJsonValue = (value: JsonValue | undefined) => (value === undefined ? "" : JSON.stringify(value, null, 2));

export const JsonEditor: React.FC<JsonEditorProps> = ({
  value,
  schema,
  onValueChange,
  onValidationChange,
  id,
  className,
  height,
}) => {
  const generatedId = useId();
  const modelUri = useMemo(
    () => `inmemory://aio-proxy/json-editor/${encodeURIComponent(id ?? generatedId)}.json`,
    [generatedId, id],
  );
  const [draft, setDraft] = useState(() => formatJsonValue(value));
  const [markers, setMarkers] = useState<readonly JsonValidationMarker[]>([]);
  const [monaco, setMonaco] = useState<Monaco>();
  const [validatedSchema, setValidatedSchema] = useState<JsonSchema | null>(null);
  const lastEmittedValue = useRef(value);

  useEffect(() => {
    if (Object.is(value, lastEmittedValue.current)) return;
    lastEmittedValue.current = value;
    setDraft(formatJsonValue(value));
  }, [value]);

  useEffect(() => {
    setMarkers([]);
    setValidatedSchema(null);
    if (!monaco || !schema) return;

    return registerJsonSchema(monaco, modelUri, {
      uri: `${modelUri}#schema`,
      fileMatch: [modelUri],
      schema,
    });
  }, [modelUri, monaco, schema]);

  const parseResult = parseJsonDraft(draft);
  const validation = useMemo(
    () =>
      mergeJsonValidation({
        syntaxValid: parseResult.ok,
        markers,
        pending: schema !== undefined && validatedSchema !== schema,
      }),
    [markers, parseResult.ok, schema, validatedSchema],
  );

  useEffect(() => {
    onValidationChange?.(validation);
  }, [onValidationChange, validation]);

  const handleChange = useCallback(
    (nextDraft: string | undefined) => {
      const nextValue = nextDraft ?? "";
      setDraft(nextValue);
      const parsed = parseJsonDraft(nextValue);
      if (!parsed.ok) return;

      lastEmittedValue.current = parsed.value;
      onValueChange(parsed.value);
    },
    [onValueChange],
  );

  const handleValidate = useCallback<OnValidate>(
    (nextMarkers) => {
      setMarkers(
        nextMarkers
          .filter(({ severity }) => severity >= 4)
          .map(({ severity }) => ({ severity: severity >= 8 ? "error" : "warning" })),
      );
      setValidatedSchema(schema ?? null);
    },
    [schema],
  );

  return (
    <CodeEditor
      {...(className === undefined ? {} : { className })}
      {...(height === undefined ? {} : { height })}
      invalid={!validation.valid}
      language="json"
      onChange={handleChange}
      onMount={(_editor, nextMonaco) => setMonaco(nextMonaco)}
      onValidate={handleValidate}
      path={modelUri}
      value={draft}
    />
  );
};
