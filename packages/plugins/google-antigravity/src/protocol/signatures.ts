export function validThoughtSignature(modelId: string, value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.length >= 50 || (value === "skip_thought_signature_validator" && modelId.startsWith("gemini-")))
  );
}
