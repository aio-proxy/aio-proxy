import type { z } from "zod";

export async function fetchJson<TSchema extends z.ZodType>(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  schema: TSchema,
): Promise<z.output<TSchema>> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw new Error(`Fetch JSON request failed: ${response.status}`);
  }
  return schema.parse(await response.json());
}
