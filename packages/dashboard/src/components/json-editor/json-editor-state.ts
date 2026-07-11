export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

export type JsonSchema = Readonly<Record<string, unknown>>;

export type JsonValidationMarker = {
  readonly severity: "error" | "warning";
};

export type JsonEditorValidation = {
  readonly valid: boolean;
  readonly syntaxValid: boolean;
  readonly pending: boolean;
  readonly markers: readonly JsonValidationMarker[];
};

export type JsonDraftParseResult =
  | { readonly ok: true; readonly value: JsonValue | undefined }
  | { readonly ok: false };

export type JsonValidationState = {
  readonly generation: number;
  readonly draft: string;
  readonly schema: JsonSchema | undefined;
  readonly pending: boolean;
  readonly markers: readonly JsonValidationMarker[];
};

export const createJsonEditorModelUri = (generatedId: string, id?: string) =>
  `inmemory://aio-proxy/json-editor/${encodeURIComponent(id ?? "editor")}-${encodeURIComponent(generatedId)}.json`;

export const createJsonValidationState = (draft: string, schema: JsonSchema | undefined): JsonValidationState => ({
  generation: 1,
  draft,
  schema,
  pending: true,
  markers: [],
});

export const beginJsonValidation = (
  state: JsonValidationState,
  draft: string,
  schema: JsonSchema | undefined,
): JsonValidationState => ({
  generation: state.generation + 1,
  draft,
  schema,
  pending: true,
  markers: [],
});

export const completeJsonValidation = (
  state: JsonValidationState,
  generation: number,
  markers: readonly JsonValidationMarker[],
): JsonValidationState => (generation === state.generation ? { ...state, pending: false, markers } : state);

export const parseJsonDraft = (draft: string): JsonDraftParseResult => {
  if (draft.trim() === "") return { ok: true, value: undefined };

  try {
    return { ok: true, value: JSON.parse(draft) as JsonValue };
  } catch {
    return { ok: false };
  }
};

export const mergeJsonValidation = ({
  syntaxValid,
  markers,
  pending = false,
}: {
  readonly syntaxValid: boolean;
  readonly markers: readonly JsonValidationMarker[];
  readonly pending?: boolean;
}): JsonEditorValidation => ({
  valid: syntaxValid && !pending && !markers.some(({ severity }) => severity === "error"),
  syntaxValid,
  pending,
  markers,
});
