import { describe, expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { format } from "date-fns";

import { createDefaultLogsSearch } from "../../logs-search";
import { LogsPage } from "./logs-page";

const mocks = rs.hoisted(() => ({ refetch: rs.fn(), mode: "data" }));

rs.mock("../../hooks/use-logs-query", () => ({
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

  test("opens one shared date time calendar with the Logs presets", async () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z"))} onSearchChange={rs.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Time range|时间范围/u }));

    expect(await screen.findAllByTestId("date-time-range-calendar")).toHaveLength(1);
    for (const name of [
      /Last 15 minutes|最近 15 分钟/u,
      /Last 1 hour|最近 1 小时/u,
      /Last 3 hours|最近 3 小时/u,
      /Last 6 hours|最近 6 小时/u,
      /Last 12 hours|最近 12 小时/u,
      /Last 24 hours|最近 24 小时/u,
      /Last 3 days|最近 3 天/u,
      /Last 7 days|最近 7 天/u,
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  test("applies exact typed times and resets pagination", async () => {
    const onSearchChange = rs.fn();
    const target = new Date();
    target.setDate(target.getDate() - 1);
    const from = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 8, 15);
    const to = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 9, 45);
    render(
      <LogsPage
        search={{ ...createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z")), page: 3 }}
        onSearchChange={onSearchChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Time range|时间范围/u }));
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
      target: { value: format(from, "yyyy-MM-dd HH:mm") },
    });
    fireEvent.change(screen.getByLabelText(/End|结束时间/u), {
      target: { value: format(to, "yyyy-MM-dd HH:mm") },
    });
    fireEvent.click(screen.getByRole("button", { name: /Apply|应用/u }));

    await waitFor(() => expect(onSearchChange).toHaveBeenCalledTimes(1));
    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        page: 1,
        startedAfter: from.toISOString(),
        completedBefore: new Date(to.getFullYear(), to.getMonth(), to.getDate(), 9, 45, 59, 999).toISOString(),
      }),
    );
  });

  test("clears only the date range back to today's default", () => {
    const onSearchChange = rs.fn();
    render(
      <LogsPage
        search={{
          ...createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z")),
          page: 3,
          outcome: "failure",
        }}
        onSearchChange={onSearchChange}
      />,
    );

    const beforeClear = new Date();
    fireEvent.click(screen.getByRole("button", { name: /Clear time range|清除时间范围/u }));
    const afterClear = new Date();

    const cleared = onSearchChange.mock.calls.at(-1)?.[0];
    expect(cleared).toEqual(expect.objectContaining({ page: 1, outcome: "failure" }));
    const startedAfter = new Date(cleared?.startedAfter ?? "");
    const completedBefore = new Date(cleared?.completedBefore ?? "");
    expect(localClock(startedAfter)).toEqual([0, 0, 0, 0]);
    expect(localClock(completedBefore)).toEqual([23, 59, 59, 999]);
    expect(localDate(completedBefore)).toEqual(localDate(startedAfter));
    expect([localDate(beforeClear), localDate(afterClear)]).toContainEqual(localDate(startedAfter));
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
        search={{
          ...createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z")),
          page: 3,
          outcome: "failure",
        }}
        onSearchChange={onSearchChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /More filters|更多筛选/u }));
    fireEvent.change(await screen.findByRole("textbox", { name: /Request ID|请求 ID/u }), {
      target: { value: "request-exact" },
    });

    expect(onSearchChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, requestId: "request-exact", outcome: "failure" }),
    );
  });

  test("does not expose current-page filtering, sorting, or column controls", () => {
    render(
      <LogsPage search={createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z"))} onSearchChange={rs.fn()} />,
    );

    expect(screen.queryByRole("textbox", { name: /Filter current page|筛选当前页/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Columns|列/u })).toBeNull();
    expect(screen.getByText(/Completed|完成时间/u).closest("button")).toBeNull();
  });

  test("updates common filter controls when search changes via navigation", () => {
    const { rerender } = render(
      <LogsPage
        search={{
          ...createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z")),
          requestedModelId: "gpt-5",
          outcome: "failure",
          inboundProtocol: "openai-chat",
        }}
        onSearchChange={rs.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: /Requested model|请求模型/u })).toHaveValue("gpt-5");
    expect(screen.getByRole("combobox", { name: /Outcome|结果/u })).toHaveTextContent(/failure/u);
    expect(screen.getByRole("combobox", { name: /Protocol|协议/u })).toHaveTextContent(/openai-chat/u);

    rerender(
      <LogsPage search={createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z"))} onSearchChange={rs.fn()} />,
    );

    expect(screen.getByRole("textbox", { name: /Requested model|请求模型/u })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: /Outcome|结果/u })).not.toHaveTextContent(/failure/u);
    expect(screen.getByRole("combobox", { name: /Protocol|协议/u })).not.toHaveTextContent(/openai-chat/u);
  });

  test("resets all filters to defaults", () => {
    const onSearchChange = rs.fn();
    render(
      <LogsPage
        search={{ ...createDefaultLogsSearch(new Date("2026-07-12T08:00:00.000Z")), outcome: "failure", page: 3 }}
        onSearchChange={onSearchChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Reset|重置/u }));

    expect(onSearchChange).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
    expect(onSearchChange.mock.calls.at(-1)?.[0]).not.toHaveProperty("outcome");
  });
});

const localDate = (date: Date) => [date.getFullYear(), date.getMonth(), date.getDate()];
const localClock = (date: Date) => [date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
