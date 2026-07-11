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
