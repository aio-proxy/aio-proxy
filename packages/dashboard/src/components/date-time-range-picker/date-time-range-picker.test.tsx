import { afterEach, describe, expect, rs, test } from "@rstest/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { DateTimeRangePicker } from "./date-time-range-picker";

const viewport = rs.hoisted(() => ({ mobile: false }));

rs.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => viewport.mobile,
}));

afterEach(() => {
  viewport.mobile = false;
});

const value = {
  from: new Date(2026, 6, 20, 0, 0),
  to: new Date(2026, 6, 20, 23, 59, 59, 999),
};

const openPicker = () => fireEvent.click(screen.getByRole("button", { name: /Time range|时间范围/u }));

describe("DateTimeRangePicker", () => {
  test("uses a bottom Sheet on mobile", async () => {
    viewport.mobile = true;
    render(
      <DateTimeRangePicker
        value={value}
        presets={[
          { id: "today", label: "Today", resolve: () => value },
          { id: "yesterday", label: "Yesterday", resolve: () => value },
        ]}
        onChange={rs.fn()}
      />,
    );

    openPicker();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAttribute("data-slot", "sheet-content");
    expect(dialog).toHaveAttribute("data-side", "bottom");
    expect(within(dialog).getAllByTestId("date-time-range-calendar")).toHaveLength(1);
    expect(within(dialog).getAllByRole("button", { name: "Today" })).toHaveLength(1);
    expect(within(dialog).getByLabelText(/Start|开始时间/u)).toBeTruthy();
    expect(within(dialog).getByLabelText(/End|结束时间/u)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Apply|应用/u })).toBeTruthy();

    const panel = within(dialog).getByTestId("date-time-range-panel");
    const calendar = within(dialog).getByTestId("date-time-range-calendar");
    const presets = dialog.querySelector('[data-slot="date-time-range-presets"]');
    const fields = dialog.querySelector('[data-slot="date-time-range-fields"]');
    const actions = dialog.querySelector('[data-slot="date-time-range-actions"]');
    if (presets === null || fields === null || actions === null) throw new Error("Expected responsive picker regions");

    expect(dialog).toHaveClass("rounded-t-3xl");
    expect(panel).toHaveClass("w-full");
    expect(calendar).toHaveClass("w-full", "p-0");
    expect(calendar).not.toHaveClass("w-fit");
    expect(presets).toHaveClass("grid-cols-2");
    expect(fields).toHaveClass("grid");
    expect(fields).not.toHaveClass("grid-cols-2");
    expect(actions).toHaveClass("sticky", "bottom-0");
    expect(within(actions as HTMLElement).getByRole("button", { name: /Apply|应用/u })).toHaveClass("w-full");
  });

  test("uses a Popover on desktop", async () => {
    render(
      <DateTimeRangePicker
        value={value}
        presets={[{ id: "today", label: "Today", resolve: () => value }]}
        onChange={rs.fn()}
      />,
    );

    openPicker();
    const panel = await screen.findByTestId("date-time-range-panel");
    const primary = panel.querySelector('[data-slot="date-time-range-primary"]');
    const presets = panel.querySelector('[data-slot="date-time-range-presets"]');
    const fields = panel.querySelector('[data-slot="date-time-range-fields"]');
    const actions = panel.querySelector('[data-slot="date-time-range-actions"]');
    if (primary === null || presets === null || fields === null || actions === null) {
      throw new Error("Expected desktop picker regions");
    }

    expect(panel).toHaveClass("w-128", "max-w-[calc(100vw-2rem)]");
    expect(primary).toHaveClass("grid-cols-[minmax(0,1fr)_11rem]");
    expect(presets).toHaveClass("grid", "content-start");
    expect(presets).not.toHaveClass("flex-wrap");
    expect(within(presets as HTMLElement).getByRole("button", { name: "Today" })).toHaveClass(
      "hover:bg-muted",
      "justify-start",
    );
    expect(fields).toHaveClass("grid-cols-2");
    expect(actions).toHaveClass("justify-end");
    expect(document.querySelector('[data-slot="popover-content"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
  });

  test("keeps calendar and time edits in draft until Apply", async () => {
    const onChange = rs.fn();
    render(<DateTimeRangePicker value={value} onChange={onChange} />);

    openPicker();
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
      target: { value: "2026-07-20 08:15" },
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Apply|应用/u }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0]?.[0].from).toEqual(new Date(2026, 6, 20, 8, 15, 0, 0));
  });

  test("derives Calendar selection from manual draft edits", async () => {
    render(<DateTimeRangePicker value={value} onChange={rs.fn()} />);
    openPicker();
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
      target: { value: "2026-07-21 00:00" },
    });
    fireEvent.change(screen.getByLabelText(/End|结束时间/u), {
      target: { value: "2026-07-21 23:59" },
    });

    expect(
      within(screen.getByTestId("date-time-range-calendar")).getByRole("button", {
        name: /Tuesday, July 21st, 2026/u,
      }),
    ).toHaveAttribute("data-range-start", "true");
  });

  test("resolves a preset once and waits for Apply", async () => {
    const onChange = rs.fn();
    const now = new Date(2026, 6, 20, 12, 0);
    const resolve = rs.fn(() => ({ from: new Date(2026, 6, 20, 11, 0), to: now }));
    render(
      <DateTimeRangePicker
        value={{ from: now, to: now }}
        presets={[{ id: "1h", label: "Past hour", resolve }]}
        onChange={onChange}
      />,
    );

    openPicker();
    fireEvent.click(await screen.findByRole("button", { name: "Past hour" }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Apply|应用/u }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(onChange.mock.calls[0]?.[0].from).toEqual(new Date(2026, 6, 20, 11, 0));
  });

  test("disables Apply for invalid or reversed text", async () => {
    render(<DateTimeRangePicker value={value} onChange={rs.fn()} />);
    openPicker();
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), { target: { value: "bad" } });
    expect(screen.getByRole("button", { name: /Apply|应用/u })).toBeDisabled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  test("renders an invalid or after-max End error beside End", async () => {
    render(<DateTimeRangePicker value={value} max={new Date(2026, 6, 20, 23, 59, 59, 999)} onChange={rs.fn()} />);
    openPicker();
    const start = await screen.findByLabelText(/Start|开始时间/u);
    const end = screen.getByLabelText(/End|结束时间/u);
    fireEvent.change(end, { target: { value: "2026-07-21 00:00" } });

    const startField = start.closest('[data-slot="field"]');
    const endField = end.closest('[data-slot="field"]');
    expect(startField).not.toBeNull();
    expect(endField).not.toBeNull();
    expect(within(startField as HTMLElement).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(endField as HTMLElement).getByRole("alert")).toHaveTextContent(
      /End is after the allowed range|结束时间晚于允许范围/u,
    );
    expect(screen.getByRole("button", { name: /Apply|应用/u })).toBeDisabled();
  });

  test("discards the draft when the Popover closes without Apply", async () => {
    const onChange = rs.fn();
    render(<DateTimeRangePicker value={value} onChange={onChange} />);
    openPicker();
    fireEvent.change(await screen.findByLabelText(/Start|开始时间/u), {
      target: { value: "2026-07-20 08:15" },
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText(/Start|开始时间/u)).not.toBeInTheDocument());
    expect(onChange).not.toHaveBeenCalled();
  });

  test("renders one calendar month and writes full-day boundaries after a completed selection", async () => {
    render(<DateTimeRangePicker value={value} onChange={rs.fn()} />);
    openPicker();
    const calendar = await screen.findByTestId("date-time-range-calendar");
    expect(within(calendar).getAllByRole("grid")).toHaveLength(1);

    fireEvent.click(within(calendar).getByRole("button", { name: /Tuesday, July 21st, 2026/u }));
    expect(screen.getByLabelText(/Start|开始时间/u)).toHaveValue("2026-07-20 00:00");
    expect(screen.getByLabelText(/End|结束时间/u)).toHaveValue("2026-07-21 23:59");
  });

  test("clears immediately from the default trigger without opening", () => {
    const onChange = rs.fn();
    render(<DateTimeRangePicker value={value} allowClear onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /Clear time range|清除时间范围/u }));
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(screen.queryByRole("button", { name: /Apply|应用/u })).toBeNull();
  });

  test("uses a custom trigger and leaves clear ownership to it", () => {
    render(
      <DateTimeRangePicker
        value={value}
        trigger={<button type="button">Custom range</button>}
        allowClear
        onChange={rs.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /Clear time range|清除时间范围/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Custom range" }));
    expect(screen.getByRole("button", { name: /Apply|应用/u })).toBeTruthy();
  });

  test("opens with empty fields for invalid external Dates", async () => {
    render(<DateTimeRangePicker value={{ from: new Date(Number.NaN), to: new Date(Number.NaN) }} onChange={rs.fn()} />);
    openPicker();
    expect(await screen.findByLabelText(/Start|开始时间/u)).toHaveValue("");
    expect(screen.getByLabelText(/End|结束时间/u)).toHaveValue("");
    expect(screen.getByRole("button", { name: /Apply|应用/u })).toBeDisabled();
  });
});
