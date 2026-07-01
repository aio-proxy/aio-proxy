import { describe, expect, test } from "bun:test";
import { createDashboardEventHub } from "../src/dashboard-events";

describe("dashboard event hub", () => {
  test("Given canceled event stream When hub closes Then close is idempotent", async () => {
    // Given
    const hub = createDashboardEventHub();
    const stream = new Response(hub.stream());
    const reader = stream.body?.getReader();

    // When
    await reader?.cancel();

    // Then
    expect(() => hub.close()).not.toThrow();
  });
});
