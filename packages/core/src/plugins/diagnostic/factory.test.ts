import { describe, expect, test } from "bun:test";

import { createPluginDiagnosticFactory } from ".";

describe("createPluginDiagnosticFactory", () => {
  test("centralizes localized summaries, safe identifiers, and injected timestamps", () => {
    const diagnostic = createPluginDiagnosticFactory(() => 123)("CAPABILITY_MISSING", {
      plugin: "not a package secret-plugin",
      capability: "secret capability",
      providerId: "provider",
      retryable: false,
      suggestedCommand: "aio-proxy provider login",
    });

    expect(diagnostic).toEqual({
      code: "CAPABILITY_MISSING",
      occurredAt: new Date(123).toISOString(),
      retryable: false,
      suggestedCommand: "aio-proxy provider login",
      summary: "Plugin <plugin> does not provide capability <capability>.",
    });
    expect(diagnostic.summary).not.toContain("secret");
  });
});
