import { expect } from "bun:test";
import { ConfigAuthoringSchema, ProviderKind, ProviderProtocol } from "../src/index";

export const apiProvider = {
  kind: ProviderKind.Api,
  protocol: ProviderProtocol.OpenAICompatible,
  baseURL: "https://api.example.com",
};

export const providers = (entries: Record<string, unknown>) => ({ providers: entries });

export function expectIssuePath(input: unknown, path: (string | number)[]) {
  const result = ConfigAuthoringSchema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path)).toContainEqual(path);
  }
}
