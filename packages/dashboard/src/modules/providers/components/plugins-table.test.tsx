import type { DashboardPluginSummary } from "@aio-proxy/types";
import { describe, expect, test } from "@rstest/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PluginsTable } from "./plugins-table";

const plugins: readonly DashboardPluginSummary[] = [
  {
    packageName: "@aio-proxy/plugin-github-copilot",
    builtIn: true,
    version: "0.0.0",
    state: { status: "ready" },
  },
  {
    packageName: "@example/broken",
    builtIn: false,
    version: "1.2.3",
    state: {
      status: "failed",
      diagnostic: {
        code: "PLUGIN_LOAD_FAILED",
        summary: "Plugin setup failed.",
        retryable: true,
        occurredAt: "2026-07-14T00:00:00.000Z",
        suggestedCommand: "aio-proxy plugin config @example/broken",
      },
    },
  },
];

describe("plugins table", () => {
  test("renders built-in and third-party plugin diagnostics without management controls", () => {
    render(<PluginsTable plugins={plugins} />);

    const builtIn = within(screen.getByTestId("plugin-row-@aio-proxy/plugin-github-copilot"));
    expect(builtIn.getByText("@aio-proxy/plugin-github-copilot")).toBeTruthy();
    expect(builtIn.getByText(/Built-in|内置/u)).toBeTruthy();
    expect(builtIn.getByText(/Ready|就绪/u)).toBeTruthy();

    const thirdParty = within(screen.getByTestId("plugin-row-@example/broken"));
    expect(thirdParty.getByText(/Third-party|第三方/u)).toBeTruthy();
    expect(thirdParty.getByText(/Failed|失败/u)).toBeTruthy();
    expect(thirdParty.getByText("Plugin setup failed.")).toBeTruthy();
    expect(thirdParty.getByText("aio-proxy plugin config @example/broken")).toBeTruthy();

    expect(screen.queryByRole("button", { name: /Install|安装/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Configure|配置/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Login|登录/u })).toBeNull();
    expect(screen.queryByLabelText(/Secret|密钥/u)).toBeNull();
  });

  test("sorts plugins from a column header control", () => {
    render(<PluginsTable plugins={[...plugins].reverse()} />);

    fireEvent.click(screen.getByRole("button", { name: /Package|包名/u }));

    const rows = screen.getAllByTestId(/^plugin-row-/u);
    expect(rows[0]?.getAttribute("data-testid")).toBe("plugin-row-@aio-proxy/plugin-github-copilot");
  });

  test("filters plugins from the table filter control", () => {
    render(<PluginsTable plugins={plugins} />);

    fireEvent.change(screen.getByRole("textbox", { name: /Filter plugins|筛选插件/u }), {
      target: { value: "broken" },
    });

    expect(screen.queryByTestId("plugin-row-@aio-proxy/plugin-github-copilot")).toBeNull();
    expect(screen.getByTestId("plugin-row-@example/broken")).toBeTruthy();
  });

  test("toggles plugin columns from the column visibility control", async () => {
    render(<PluginsTable plugins={plugins} />);

    expect(screen.getByRole("columnheader", { name: /Version|版本/u })).toBeTruthy();
    const trigger = screen.getByRole("button", { name: /Columns|列/iu });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /Version|版本/u, checked: true }));

    expect(screen.queryByRole("columnheader", { name: /Version|版本/u })).toBeNull();
    expect(await screen.findByRole("menuitemcheckbox", { name: /Version|版本/u, checked: false })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  test("pages forward and backward through more than one page of plugins", () => {
    const pagedPlugins: readonly DashboardPluginSummary[] = Array.from({ length: 11 }, (_, index) => ({
      packageName: `@example/plugin-${index}`,
      builtIn: false,
      version: "1.0.0",
      state: { status: "ready" },
    }));
    render(<PluginsTable plugins={pagedPlugins} />);

    expect(screen.getByTestId("plugin-row-@example/plugin-0")).toBeTruthy();
    expect(screen.queryByTestId("plugin-row-@example/plugin-10")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Next|下一页/u }));
    expect(screen.queryByTestId("plugin-row-@example/plugin-0")).toBeNull();
    expect(screen.getByTestId("plugin-row-@example/plugin-10")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Previous|上一页/u }));
    expect(screen.getByTestId("plugin-row-@example/plugin-0")).toBeTruthy();
  });
});
