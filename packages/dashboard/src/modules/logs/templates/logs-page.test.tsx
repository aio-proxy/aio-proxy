import { describe, expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { createDefaultLogsSearch } from "../logs-search";
import { LogsPage } from "./logs-page";

const mocks = rs.hoisted(() => ({ refetch: rs.fn() }));

rs.mock("../hooks/use-logs-query", () => ({
  useLogsQuery: () => ({
    data: {
      page: 1,
      pageSize: 50,
      total: 1,
      pageCount: 1,
      items: [
        {
          requestId: "request-1",
          inboundProtocol: "openai-compatible",
          requestedModelId: "mini",
          outcome: "success",
          finalProviderId: "openrouter",
          finalModelId: "openai/gpt-5",
          finalStatusCode: 200,
          attempts: [
            {
              index: 0,
              providerId: "openrouter",
              modelId: "openai/gpt-5",
              providerKind: "api",
              protocol: "openai-compatible",
              outcome: "success",
              statusCode: 200,
              durationMs: 80,
            },
          ],
          startedAt: "2026-07-12T07:59:59.900Z",
          completedAt: "2026-07-12T08:00:00.000Z",
          durationMs: 100,
          usage: {
            providerId: "openrouter",
            modelId: "openai/gpt-5",
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            estimatedCostUsd: 0.25,
          },
        },
      ],
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: mocks.refetch,
  }),
}));

describe("logs page", () => {
  test("renders request usage and opens ordered attempt details with the keyboard", () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z"))} onSearchChange={rs.fn()} />,
    );

    expect(screen.getByText("openrouter")).toBeTruthy();
    expect(screen.getByText("150")).toBeTruthy();
    const row = screen.getByRole("button", { name: /request-1/u });
    fireEvent.keyDown(row, { key: "Enter" });
    expect(screen.getByText("request-1")).toBeTruthy();
    expect(screen.getByText(/#1 · openrouter \/ openai\/gpt-5/u)).toBeTruthy();
  });

  test("manually refreshes without changing the search", () => {
    const onSearchChange = rs.fn();
    render(
      <LogsPage
        search={createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z"))}
        onSearchChange={onSearchChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Refresh|刷新/u }));
    expect(mocks.refetch).toHaveBeenCalled();
    expect(onSearchChange).not.toHaveBeenCalled();
  });
});
