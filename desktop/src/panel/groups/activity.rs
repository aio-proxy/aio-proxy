//! The Last 12 months group: a horizontally scrolling heatmap of weekly columns, each day with the
//! Dashboard's hover card.

use gpui_kit::component::*;
use gpui_kit::*;

use super::group_header::group_header;
use std::time::Duration;

use gpui_kit::component::hover_card::HoverCard;

use crate::panel::activity::{HeatCell, HeatGrid, WEEKS, long_date};
use crate::panel::format::compact;
use crate::panel::view::PanelView;
use crate::summary::ActivityModel;

const CELL: f32 = 10.;
const GAP: f32 = 2.;

pub fn header(grid: &HeatGrid, cx: &App) -> Div {
    let text = format!("{} active days · {} tokens", grid.active_days, compact(grid.total_tokens));
    group_header("Last 12 months", div().text_xs().text_color(crate::theme::colors(cx).muted_foreground).child(text))
}

fn level_color(level: u8, cx: &App) -> Hsla {
    crate::theme::colors(cx).heat[usize::from(level.min(4))]
}

/// The Dashboard's day hover card: the date, the day's tokens, and its model split.
fn day_card(cell: HeatCell, models: &[ActivityModel], cx: &App) -> Div {
    let theme = crate::theme::colors(cx);
    let breakdown = (!models.is_empty()).then(|| {
        v_flex()
            .mt_3()
            .pt_3()
            .border_t_1()
            .border_color(theme.border)
            .gap_2()
            .child(div().text_xs().font_medium().text_color(theme.muted_foreground).child("Model breakdown"))
            .children(models.iter().map(|model| {
                let share = if cell.tokens == 0 { 0.0 } else { model.total_tokens as f64 / cell.tokens as f64 };
                v_flex()
                    .gap_1()
                    .child(
                        h_flex()
                            .justify_between()
                            .gap_3()
                            .text_xs()
                            .child(
                                h_flex()
                                    .min_w_0()
                                    .gap_1()
                                    .child(div().min_w_0().truncate().child(model.model_id.clone()))
                                    .child(
                                        div()
                                            .flex_shrink_0()
                                            .text_color(theme.muted_foreground)
                                            .child(compact(model.total_tokens)),
                                    ),
                            )
                            .child(div().flex_shrink_0().child(format!("{:.0}%", share * 100.0))),
                    )
                    .child(
                        div()
                            .h(px(6.))
                            .rounded_full()
                            .bg(theme.muted)
                            .child(div().h_full().w(relative(share as f32)).rounded_full().bg(theme.primary)),
                    )
            }))
    });
    v_flex()
        .w(px(240.))
        .child(div().text_sm().font_medium().child(long_date(cell.day)))
        .child(div().mt_2().text_sm().child(format!("{} Token", compact(cell.tokens))))
        .children(breakdown)
}

fn cell(cell: Option<HeatCell>, grid: &HeatGrid, cx: &App) -> AnyElement {
    let Some(cell) = cell else {
        // After today: an empty slot keeps the column's shape.
        return div().size(px(CELL)).into_any_element();
    };
    let models = grid.models.get(&cell.day).cloned().unwrap_or_default();
    HoverCard::new(("day", cell.day as u64))
        // Above the cell, left edges aligned: the Dashboard's `side="top" align="start"`.
        .anchor(Anchor::BottomLeft)
        .open_delay(Duration::ZERO)
        .close_delay(Duration::ZERO)
        .trigger(div().size(px(CELL)).rounded(px(2.)).bg(level_color(cell.level, cx)))
        .content(move |_, _, cx| day_card(cell, &models, cx))
        .into_any_element()
}

pub fn activity(view: &PanelView, grid: &HeatGrid, cx: &Context<PanelView>) -> impl IntoElement {
    let muted = crate::theme::colors(cx).muted_foreground;
    let width = WEEKS as f32 * (CELL + GAP) - GAP;
    let months = div().relative().h(px(12.)).children(grid.months.iter().map(|&(week, name)| {
        let label = div().absolute();
        // A label is wider than one column: one starting in the last two would run past the grid's
        // end and be clipped, so it hangs from the end instead.
        let label = if week + 2 >= WEEKS { label.right_0() } else { label.left(px(week as f32 * (CELL + GAP))) };
        label.whitespace_nowrap().text_size(px(9.)).text_color(muted).child(name)
    }));
    let columns = h_flex().items_start().gap(px(GAP)).children(
        grid.weeks.iter().map(|week| v_flex().gap(px(GAP)).children(week.iter().map(|&c| cell(c, grid, cx)))),
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
        .child(header(grid, cx))
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
