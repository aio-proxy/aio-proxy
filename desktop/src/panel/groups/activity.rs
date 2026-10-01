//! The Last 12 months group: a horizontally scrolling heatmap of weekly columns.

use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::group_header::group_header;
use crate::panel::activity::{HeatCell, HeatGrid, WEEKS, day_label};
use crate::panel::format::compact;
use crate::panel::view::PanelView;

const CELL: f32 = 10.;
const GAP: f32 = 2.;

pub fn header(view: &PanelView, grid: &HeatGrid, cx: &App) -> Div {
    let selected = view.day.and_then(|day| grid.weeks.iter().flatten().flatten().find(|cell| cell.day == day));
    let text = match selected {
        Some(cell) => format!("{} · {} tokens", day_label(cell.day), compact(cell.tokens)),
        None => format!("{} active days · {} tokens", grid.active_days, compact(grid.total_tokens)),
    };
    group_header("Last 12 months", div().text_xs().text_color(cx.theme().muted_foreground).child(text))
}

fn level_color(level: u8, cx: &App) -> Hsla {
    let theme = cx.theme();
    if level == 0 { theme.muted } else { theme.chart_1.opacity(f32::from(level) / 4.0) }
}

fn cell(view: &PanelView, cell: Option<HeatCell>, cx: &Context<PanelView>) -> AnyElement {
    let Some(cell) = cell else {
        // After today: an empty slot keeps the column's shape.
        return div().size(px(CELL)).into_any_element();
    };
    let day = cell.day;
    div()
        .id(("day", day as u64))
        .size(px(CELL))
        .rounded(px(2.))
        .bg(level_color(cell.level, cx))
        .when(view.day == Some(day), |c| c.border_1().border_color(cx.theme().foreground))
        .cursor_pointer()
        .on_click(cx.listener(move |view, _, _, cx| {
            view.day = if view.day == Some(day) { None } else { Some(day) };
            cx.notify();
        }))
        .into_any_element()
}

pub fn activity(view: &PanelView, grid: &HeatGrid, cx: &Context<PanelView>) -> impl IntoElement {
    let muted = cx.theme().muted_foreground;
    let width = WEEKS as f32 * (CELL + GAP) - GAP;
    let months = div().relative().h(px(12.)).children(grid.months.iter().map(|&(week, name)| {
        div()
            .absolute()
            .left(px(week as f32 * (CELL + GAP)))
            .whitespace_nowrap()
            .text_size(px(9.))
            .text_color(muted)
            .child(name)
    }));
    let columns = h_flex().items_start().gap(px(GAP)).children(
        grid.weeks.iter().map(|week| v_flex().gap(px(GAP)).children(week.iter().map(|&c| cell(view, c, cx)))),
    );
    // The legend stays outside the scroller, so it is visible at the latest week.
    let legend = h_flex()
        .justify_end()
        .items_center()
        .gap(px(GAP))
        .pt_1()
        .text_size(px(9.))
        .text_color(muted)
        .child("Less")
        .children((0..=4).map(|level| div().size(px(CELL)).rounded(px(2.)).bg(level_color(level, cx))))
        .child("More");
    v_flex()
        .pb_3()
        .child(header(view, grid, cx))
        .child(
            div()
                .id("heatmap")
                .w_full()
                .overflow_x_scroll()
                .restrict_scroll_to_axis()
                .track_scroll(&view.heat)
                .child(v_flex().w(px(width)).flex_shrink_0().gap(px(GAP)).child(months).child(columns)),
        )
        .child(legend)
}
