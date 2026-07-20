import { describe, expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen } from "@testing-library/react";

import { createDefaultLogsSearch } from "../logs-search";
import { LogsPage } from "./logs-page";

const mocks = rs.hoisted(() => ({ refetch: rs.fn(), mode: "data" }));

rs.mock("../hooks/use-logs-query", () => ({
  useLogsQuery: () =>
    mocks.mode === "loading"
      ? { isLoading: true, isError: false, isFetching: false, refetch: mocks.refetch }
      : mocks.mode === "error"
        ? { isLoading: false, isError: true, isFetching: false, refetch: mocks.refetch }
        : {
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
            ...(mocks.mode === "empty" ? { data: { page: 1, pageSize: 50, total: 0, pageCount: 0, items: [] } } : {}),
          },
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

  test("uses one accessible date range picker without custom presets", () => {
    const { container } = render(
      <LogsPage search={createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z"))} onSearchChange={rs.fn()} />,
    );

    expect(screen.getByRole("button", { name: /Time range|时间范围/u })).toBeTruthy();
    expect(container.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /Last 7 days|近 7 天/u })).toBeNull();
  });

  test("renders rows per page inside the table pagination", () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z"))} onSearchChange={rs.fn()} />,
    );

    expect(screen.getByRole("combobox", { name: /Rows per page|每页行数/u })).toBeTruthy();
  });

  test.each([
    ["loading", /Loading request logs|正在加载请求日志/u],
    ["empty", /No matching requests|没有匹配的请求/u],
    ["error", /Request logs unavailable|无法加载请求日志/u],
  ])("renders the %s state", (mode, name) => {
    mocks.mode = mode;
    render(
      <LogsPage search={createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z"))} onSearchChange={rs.fn()} />,
    );
    expect(screen.queryByText(name) ?? screen.queryByLabelText(name)).toBeTruthy();
    mocks.mode = "data";
  });

  test("applies an exact filter from More filters and resets pagination", async () => {
    const onSearchChange = rs.fn();
    render(
      <LogsPage
        search={{ ...createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z")), page: 3 }}
        onSearchChange={onSearchChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /More filters|更多筛选/u }));
    fireEvent.change(await screen.findByRole("textbox", { name: /Request ID|请求 ID/u }), {
      target: { value: "request-exact" },
    });

    expect(onSearchChange).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, requestId: "request-exact" }));
  });
});
