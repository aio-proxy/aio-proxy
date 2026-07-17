import { describe, expect, test } from "bun:test";

import { appWith, generateRequest } from "./gemini-generate-content.test-support";

describe("Gemini generateContent route matching", () => {
  test("Given missing method suffix When model path is posted Then Hono returns 404", async () => {
    // Given
    const app = await appWith();

    // When
    const response = await app.request("/v1beta/models/gemini-2.5-flash", {
      body: JSON.stringify(generateRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 Not Found");
  });
});
