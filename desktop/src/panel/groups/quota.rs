//! The Quota group: one block per Provider that reports quota, in attention order.

use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use gpui_kit::component::accordion::Accordion;
use gpui_kit::component::tooltip::Tooltip;

use super::group_header::group_header;
use crate::app;
use crate::panel::format::percent;
use crate::panel::quota::{self as model, QuotaBlock, WindowView, attention_count};
use crate::panel::view::PanelView;
use crate::summary::Provider;

pub fn header(blocks: &[QuotaBlock], cx: &App) -> Div {
    let theme = crate::theme::colors(cx);
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
    let theme = crate::theme::colors(cx);
    let title = match window.remaining {
        Some(remaining) => format!("{} · {} left", window.label, percent(remaining)),
        None => format!("{} · no data", window.label),
    };
    // As tall as the bar, with a background-colored gap either side, so a teal tick still reads on
    // a teal fill without sticking out of the bar.
    let tick = window.pace.as_ref().map(|pace| {
        div()
            .absolute()
            .top_0()
            .bottom_0()
            .left(relative(pace.expected as f32))
            .ml(px(-2.))
            .w(px(4.))
            .border_x_1()
            .border_color(theme.surface)
            .bg(if pace.behind { theme.error } else { theme.success })
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
                .bg(theme.track)
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

/// The plugin mark beside an OAuth title, framed like the Dashboard's `ProviderAvatar`: the plugin icon inset in a fixed square, or the
/// title's first letter when there is none or it fails to load. `None` for a non-OAuth Provider.
fn provider_mark(provider: &Provider, title: &str, cx: &App) -> Option<Div> {
    provider.service.as_ref()?;
    let theme = crate::theme::colors(cx);
    let letter: SharedString =
        title.chars().next().map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default().into();
    let fallback = move || div().text_size(px(10.)).font_semibold().child(letter.clone()).into_any_element();
    let inner = match provider.icon.as_deref().and_then(|icon| model::icon_url(icon, cx.theme().is_dark())) {
        Some(url) => img(url).size(px(12.)).with_fallback(fallback).into_any_element(),
        None => fallback(),
    };
    Some(
        div()
            .flex_shrink_0()
            .size(px(16.))
            .rounded_sm()
            .bg(theme.muted)
            .flex()
            .items_center()
            .justify_center()
            .child(inner),
    )
}

/// The title row: mark, service and account, then, while collapsed, the tightest window's bar and
/// share left, or why there is none. An open block shows its windows instead, so the account gets
/// the room.
fn title(block: &QuotaBlock, open: bool, cx: &App) -> Div {
    let theme = crate::theme::colors(cx);
    let headline = if open {
        None
    } else if block.loading {
        Some(div().text_color(theme.muted_foreground).child("Loading…").into_any_element())
    } else if block.message.is_some() {
        Some(div().text_color(theme.danger).child("Failed").into_any_element())
    } else {
        block.tightest().and_then(|window| {
            let remaining = window.remaining?;
            let behind = window.pace.as_ref().is_some_and(|p| p.behind);
            Some(
                h_flex()
                    .gap_1()
                    .items_center()
                    .child(div().w(px(32.)).h(px(4.)).rounded_full().bg(theme.track).child(
                        div().h_full().w(relative(remaining as f32)).rounded_full().bg(if window.low {
                            theme.warning
                        } else {
                            theme.success
                        }),
                    ))
                    .child(
                        div()
                            .min_w(px(30.))
                            .whitespace_nowrap()
                            .text_right()
                            .text_color(if behind { theme.error } else { theme.muted_foreground })
                            .child(percent(remaining)),
                    )
                    .into_any_element(),
            )
        })
    };
    h_flex()
        .w_full()
        .min_w_0()
        .gap_1()
        .items_center()
        .text_xs()
        .children(provider_mark(block.provider, &block.title, cx))
        .child(div().flex_shrink_0().text_sm().font_semibold().text_color(theme.foreground).child(block.title.clone()))
        // The account takes the slack, so it truncates only when the headline needs the room.
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .font_normal()
                .text_color(theme.muted_foreground)
                .children(block.subtitle.clone()),
        )
        .children(headline.map(|headline| div().flex_shrink_0().font_normal().child(headline)))
}

/// The expanded part: when it was read and the plan (with the way to the Provider in the Dashboard),
/// each window, and what went wrong.
fn details(block: &QuotaBlock, now: i64, cx: &App) -> Vec<AnyElement> {
    let theme = crate::theme::colors(cx);
    let id = block.provider.id.clone();
    let updated = block.sampled_at.map(|at| {
        if block.refresh_failed {
            format!("Last refresh failed · data from {}", model::relative(now, at))
        } else {
            format!("Updated {}", model::relative(now, at))
        }
    });
    let open = div()
        .id(SharedString::from(format!("quota-open-{id}")))
        .flex_shrink_0()
        .px_1()
        .cursor_pointer()
        .child("›")
        .tooltip(|window, cx| Tooltip::new("Open in Dashboard").build(window, cx))
        .on_click(move |_, _, cx| app::open_dashboard_provider(cx, &id));
    let meta = h_flex()
        .gap_2()
        .text_size(px(10.))
        .text_color(theme.muted_foreground)
        .child(div().flex_1().min_w_0().truncate().children(updated))
        .children(block.plan.clone().map(|plan| div().flex_shrink_0().child(plan)))
        .child(open);
    let muted_line = |text: String| div().pt_1().text_xs().text_color(theme.muted_foreground).child(text);
    let mut rows = vec![meta.into_any_element()];
    rows.extend(block.windows.iter().map(|window| window_row(window, cx).into_any_element()));
    rows.extend(
        block
            .message
            .clone()
            .map(|message| div().pt_1().text_xs().text_color(theme.danger).child(message).into_any_element()),
    );
    rows.extend(
        block
            .command
            .clone()
            .map(|command| muted_line(command).font_family(cx.theme().mono_font_family.clone()).into_any_element()),
    );
    rows
}

pub fn quota(view: &PanelView, blocks: &[QuotaBlock], now: i64, cx: &Context<PanelView>) -> impl IntoElement {
    let body = if blocks.is_empty() {
        div()
            .pb_3()
            .text_xs()
            .text_color(crate::theme::colors(cx).muted_foreground)
            .child("No Provider reports quota")
            .into_any_element()
    } else {
        let ids: Vec<String> = blocks.iter().map(|b| b.provider.id.clone()).collect();
        let panel = cx.entity().downgrade();
        let flush = StyleRefinement::default().px_0();
        let accordion = Accordion::new("quota").multiple(true).bordered(false).h_auto().pb_3();
        blocks
            .iter()
            .fold(accordion, |accordion, block| {
                let open = view.quota_open.get(&block.provider.id).copied().unwrap_or(block.opens_by_default());
                accordion.item(|item| {
                    item.open(open)
                        .title(title(block, open, cx))
                        .title_style(flush.clone())
                        .content_style(flush.clone())
                        .children(details(block, now, cx))
                })
            })
            .on_toggle_click(move |open, _, cx| {
                // A manual toggle holds until the panel closes; untouched blocks keep following attention.
                let open: Vec<(String, bool)> =
                    ids.iter().enumerate().map(|(i, id)| (id.clone(), open.contains(&i))).collect();
                let _ = panel.update(cx, |view, cx| {
                    view.quota_open.extend(open);
                    cx.notify();
                });
            })
            .into_any_element()
    };
    v_flex().child(header(blocks, cx)).child(body)
}
