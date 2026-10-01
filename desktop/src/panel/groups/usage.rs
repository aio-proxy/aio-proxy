//! The Usage group: the window switch, the metric cards, the trend and its breakdown.

use gpui_kit::component::empty::{Empty, EmptyHeader, EmptyMedia, EmptyMediaVariant, EmptyTitle};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use gpui_kit::component::tab::TabBar;

use super::group_header::group_header;
use super::trend::{series, trend};
use crate::app::{self, AppModel, SummaryState};
use crate::panel::format::percent;
use crate::panel::usage::{Metric, Series, Split, Tone, card_delta, card_value, format_value, metric_total};
use crate::panel::view::PanelView;
use crate::summary::{Usage, UsageRange};

pub fn header(model: &AppModel) -> Div {
    let selected = UsageRange::ALL.iter().position(|&range| range == model.usage_range).unwrap_or(0);
    let switch = TabBar::new("usage-range")
        .segmented()
        .xsmall()
        .selected_index(selected)
        .children(UsageRange::ALL.map(UsageRange::label))
        .on_click(|&index, _, cx| app::set_usage_range(cx, UsageRange::ALL[index]));
    group_header("Usage", switch)
}

/// `usage` is `None` before the window's first response: the cards then read `—`.
fn card(view: &PanelView, usage: Option<&Usage>, metric: Metric, cx: &Context<PanelView>) -> impl IntoElement {
    let theme = crate::theme::colors(cx);
    let (value, change) = match usage {
        // An empty previous window has nothing to compare with: every card would read `new`, so the
        // caption says it once instead.
        Some(u) if u.previous.requests == 0 => (card_value(&u.current, metric), None),
        Some(u) => (card_value(&u.current, metric), Some(card_delta(&u.current, &u.previous, metric))),
        None => ("—".to_string(), None),
    };
    // The Cost card abbreviates; its tooltip has the exact amount and how much of it is priced.
    let note = usage.filter(|_| metric == Metric::Cost).and_then(|u| {
        let coverage = u.current.pricing_coverage?;
        let exact = format_value(u.current.estimated_cost_nano_usd, metric);
        Some(SharedString::from(if coverage < 1.0 {
            format!("{exact} · {} of requests priced", percent(coverage))
        } else {
            exact
        }))
    });
    v_flex()
        .id(metric.label())
        .flex_1()
        .min_w_0()
        .p(px(6.))
        .rounded_md()
        .bg(if view.metric == metric { theme.selected } else { theme.muted })
        .border_1()
        .border_color(if view.metric == metric { theme.selected_border } else { transparent_black() })
        .cursor_pointer()
        .child(div().text_size(px(10.)).text_color(theme.muted_foreground).child(metric.label()))
        .child(
            div()
                .text_size(px(15.))
                .font_semibold()
                .font_family(cx.theme().mono_font_family.clone())
                .truncate()
                .child(value),
        )
        .children(change.map(|(text, tone)| {
            let color = match tone {
                Tone::Neutral => theme.muted_foreground,
                Tone::Bad => theme.error,
                Tone::Good => theme.success,
            };
            div().text_size(px(10.)).text_color(color).child(text)
        }))
        .when_some(note, |card, note| card.tooltip(move |window, cx| Tooltip::new(note.clone()).build(window, cx)))
        .on_click(cx.listener(move |view, _, _, cx| {
            view.metric = metric;
            cx.notify();
        }))
}

/// The trend's legend and breakdown in one: a row per series, with its color, name, value over
/// the window and share of the window's total.
fn breakdown(series: &[(Series, Hsla)], split: Split, metric: Metric, total: u128, cx: &App) -> impl IntoElement {
    let theme = crate::theme::colors(cx);
    v_flex().pt_3().gap(px(5.)).children(series.iter().map(|(series, color)| {
        let value: u128 = series.values.iter().sum();
        let share = if total == 0 { 0.0 } else { value as f64 / total as f64 };
        let label = div().flex_1().min_w_0().truncate().child(series.label.clone());
        // Model ids are code; Provider names and Other are not.
        let name = if split == Split::Model && !series.other {
            label.font_family(cx.theme().mono_font_family.clone())
        } else {
            label
        };
        h_flex()
            .gap_2()
            .items_center()
            .text_size(px(11.))
            .child(div().flex_shrink_0().size(px(8.)).rounded(px(2.)).bg(*color))
            .child(name)
            .child(div().flex_shrink_0().text_right().child(format_value(value, metric)))
            .child(
                div()
                    .w(px(32.))
                    .flex_shrink_0()
                    .text_right()
                    .text_color(theme.muted_foreground)
                    .child(if value > 0 && share < 0.01 { "<1%".to_string() } else { percent(share) }),
            )
    }))
}

pub fn usage(view: &PanelView, model: &AppModel, cx: &Context<PanelView>) -> impl IntoElement {
    let theme = crate::theme::colors(cx);
    let usage = model.usage_for(model.usage_range);
    let cards = h_flex().gap(px(5.)).children(Metric::ALL.map(|metric| card(view, usage, metric, cx)));
    let group = v_flex().pb_3().child(header(model)).child(cards);
    let Some(usage) = usage else {
        // No response for this window yet: the skeleton, or why the first fetch failed.
        let text = model.usage_error().unwrap_or("Loading…").to_string();
        return group.child(div().pt_2().text_xs().text_color(theme.muted_foreground).child(text));
    };
    let metric = view.metric;
    let total = metric_total(&usage.current, metric);
    let group = group.child(div().pt_1().text_size(px(10.)).text_color(theme.muted_foreground).child(
        if usage.previous.requests == 0 {
            format!("No usage in the previous {}", model.usage_range.label())
        } else {
            format!("Compared with the previous {}", model.usage_range.label())
        },
    ));
    if total == 0 {
        // Nothing to chart or rank: one empty state stands in for the trend and its breakdown.
        return group.child(
            Empty::new().header(
                EmptyHeader::new()
                    .media(EmptyMedia::new().with_variant(EmptyMediaVariant::Icon).child(Icon::new(IconName::Inbox)))
                    .title(EmptyTitle::new().child(metric.empty_text())),
            ),
        );
    }
    let providers = match &model.summary {
        SummaryState::Ready(summary) => summary.providers.as_slice(),
        _ => &[],
    };
    let series = series(view, usage, providers, cx);
    let group = group.child(trend(view, usage, &series, cx));
    // Spans pruned under live traffic: there is usage, but no Provider split for it.
    if view.split == Split::Provider && usage.trend_by_provider.is_empty() {
        return group.child(
            div().pt_3().text_xs().text_color(theme.muted_foreground).child("No per-Provider data for this window"),
        );
    }
    group.child(breakdown(&series, view.split, metric, total, cx))
}
