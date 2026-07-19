import { describe, expect, test } from "@rstest/core";

import { createDefaultLogsSearch } from "../logs-search";
import { logsQueryOptions } from "./logs-service";

describe("logs query options", () => {
  const search = createDefaultLogsSearch(new Date("2026-07-12T12:00:00.000Z"));

  test("keys the query by the complete search and polls only page one", () => {
    const first = logsQueryOptions(search, true);
    const history = logsQueryOptions({ ...search, page: 2 }, true);
    const disabled = logsQueryOptions(search, false);

    expect(first.queryKey).toEqual(["dashboard", "logs", search]);
    expect(first.refetchInterval).toBe(5_000);
    expect(first.refetchIntervalInBackground).toBe(false);
    expect(history.refetchInterval).toBe(false);
    expect(disabled.refetchInterval).toBe(false);
    expect(first.placeholderData?.({ items: [] } as never, {} as never)).toEqual({ items: [] });
  });
});
