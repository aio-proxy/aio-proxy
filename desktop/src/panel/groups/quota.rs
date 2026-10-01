//! The Quota group: one block per Provider that reports quota, in attention order.

use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::group_header::group_header;
use crate::app;
use crate::panel::format::percent;
use crate::panel::quota::{self as model, QuotaBlock, WindowView, attention_count};

pub fn header(blocks: &[QuotaBlock], cx: &App) -> Div {
    let theme = cx.theme();
    let attention = attention_count(blocks);
    let reporting = match blocks.len() {
        0 => None,
        1 => Some("1 Provider reports quota".to_string()),
        n => Some(format!("{n} Providers report quota")),
    };
    let right = h_flex()
        .gap_1()
        .text_xs()
        .text_color(theme.muted_foreground)
        .when(attention > 0, |right| {
            right.child(div().text_color(theme.danger).child(format!("{attention} need attention"))).child("·")
        })
        .children(reporting);
    group_header("Quota", right)
}

fn window_row(window: &WindowView, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let title = match window.remaining {
        Some(remaining) => format!("{} · {} left", window.label, percent(remaining)),
        None => format!("{} · no data", window.label),
    };
    // Taller than the bar, so a teal tick still shows on a teal fill.
    let tick = window.pace.as_ref().map(|pace| {
        div().absolute().top(px(-2.)).h(px(10.)).left(relative(pace.expected as f32)).w(px(2.)).bg(if pace.behind {
            theme.danger
        } else {
            theme.success
        })
    });
    v_flex()
        .gap_1()
        .pt_2()
        .child(h_flex().justify_between().gap_2().text_xs().child(div().min_w_0().truncate().child(title)).children(
            window.left_text.clone().map(|text| div().flex_shrink_0().text_color(theme.muted_foreground).child(text)),
        ))
        .child(
            div()
                .relative()
                .h(px(6.))
                .w_full()
                .rounded_full()
                .bg(theme.muted)
                .child(
                    div()
                        .h_full()
                        .w(relative(window.remaining.unwrap_or(0.0) as f32))
                        .rounded_full()
                        .bg(if window.low { theme.warning } else { theme.success }),
                )
                .children(tick),
        )
        .children(window.pace.as_ref().map(|pace| {
            div()
                .text_size(px(10.))
                .text_color(if pace.behind { theme.danger } else { theme.muted_foreground })
                .child(pace.note.clone())
        }))
}

fn block(block: &QuotaBlock, now: i64, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let provider = block.provider;
    let id = provider.id.clone();
    let title = h_flex()
        .id(SharedString::from(format!("quota-{}", provider.id)))
        .gap_1()
        .items_center()
        .cursor_pointer()
        .child(div().flex_shrink_0().text_sm().font_semibold().child(provider.name.clone()))
        .children(
            provider
                .account_label
                .clone()
                .map(|label| div().min_w_0().truncate().text_xs().text_color(theme.muted_foreground).child(label)),
        )
        .child(div().flex_1())
        .child(div().text_color(theme.muted_foreground).child("›"))
        .on_click(move |_, _, cx| app::open_dashboard_provider(cx, &id));
    let updated = block.sampled_at.map(|at| {
        if block.refresh_failed {
            format!("Last refresh failed · data from {}", model::relative(now, at))
        } else {
            format!("Updated {}", model::relative(now, at))
        }
    });
    let meta = (updated.is_some() || block.plan.is_some()).then(|| {
        h_flex()
            .justify_between()
            .gap_2()
            .text_size(px(10.))
            .text_color(theme.muted_foreground)
            .child(div().min_w_0().truncate().children(updated))
            .children(block.plan.clone().map(|plan| div().flex_shrink_0().child(plan)))
    });
    let muted_line = |text: String| div().pt_1().text_xs().text_color(theme.muted_foreground).child(text);
    v_flex()
        .py_2()
        .border_b_1()
        .border_color(theme.border)
        .child(title)
        .children(meta)
        .children(block.loading.then(|| muted_line("Loading quota…".into())))
        .children(block.windows.iter().map(|window| window_row(window, cx)))
        .children(block.message.clone().map(|message| div().pt_1().text_xs().text_color(theme.danger).child(message)))
        .children(block.command.clone().map(|command| muted_line(command).font_family(theme.mono_font_family.clone())))
}

pub fn quota(blocks: &[QuotaBlock], now: i64, cx: &App) -> impl IntoElement {
    let body = if blocks.is_empty() {
        div()
            .pb_3()
            .text_xs()
            .text_color(cx.theme().muted_foreground)
            .child("No Provider reports quota")
            .into_any_element()
    } else {
        v_flex().pb_3().children(blocks.iter().map(|b| block(b, now, cx))).into_any_element()
    };
    v_flex().child(header(blocks, cx)).child(body)
}
