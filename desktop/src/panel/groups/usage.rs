//! The Usage group: the window switch, the metric cards, the trend bars and the two breakdowns.

use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::group_header::group_header;
use crate::app::{self, AppModel};
use crate::panel::format::{local_utc_offset, percent};
use crate::panel::usage::{
    Metric, Tone, bucket_label, card_delta, card_value, format_value, metric_total, ranked, slice_value,
};
use crate::panel::view::PanelView;
use crate::summary::{BucketUnit, Usage, UsageRange};

pub fn header(model: &AppModel, cx: &Context<PanelView>) -> Div {
    let theme = cx.theme();
    let switch = h_flex().p(px(2.)).gap(px(2.)).rounded_md().bg(theme.muted).children(UsageRange::ALL.map(|range| {
        let selected = range == model.usage_range;
        div()
            .id(range.query())
            .px_2()
            .rounded_sm()
            .text_xs()
            .cursor_pointer()
            .text_color(if selected { theme.foreground } else { theme.muted_foreground })
            .when(selected, |segment| segment.bg(theme.background))
            .child(range.label())
            .on_click(cx.listener(move |view, _, _, cx| {
                // Bar indexes mean different buckets in another window.
                view.bar = None;
                app::set_usage_range(cx, range);
            }))
    }));
    group_header("Usage", switch)
}

/// `usage` is `None` before the window's first response: the cards then read `—`.
fn card(view: &PanelView, usage: Option<&Usage>, metric: Metric, cx: &Context<PanelView>) -> impl IntoElement {
    let theme = cx.theme();
    let (value, change) = match usage {
        Some(u) => (card_value(&u.current, metric), Some(card_delta(&u.current, &u.previous, metric))),
        None => ("—".to_string(), None),
    };
    let coverage = usage
        .and_then(|u| u.current.pricing_coverage)
        .filter(|&c| metric == Metric::Cost && c < 1.0)
        .map(|c| SharedString::from(format!("{} of requests priced", percent(c))));
    v_flex()
        .id(metric.label())
        .flex_1()
        .min_w_0()
        .p(px(6.))
        .rounded_md()
        .bg(theme.muted)
        .border_1()
        .border_color(if view.metric == metric { theme.success } else { transparent_black() })
        .cursor_pointer()
        .child(div().text_size(px(10.)).text_color(theme.muted_foreground).child(metric.label()))
        .child(
            div()
                .text_size(px(15.))
                .font_semibold()
                .font_family(theme.mono_font_family.clone())
                .truncate()
                .child(value),
        )
        .children(change.map(|(text, tone)| {
            let color = match tone {
                Tone::Neutral => theme.muted_foreground,
                Tone::Bad => theme.danger,
                Tone::Good => theme.success,
            };
            div().text_size(px(10.)).text_color(color).child(text)
        }))
        .when_some(coverage, |card, note| card.tooltip(move |window, cx| Tooltip::new(note.clone()).build(window, cx)))
        .on_click(cx.listener(move |view, _, _, cx| {
            view.metric = metric;
            view.bar = None;
            cx.notify();
        }))
}

fn value_words(value: u128, metric: Metric) -> String {
    let value = format_value(value, metric);
    match metric {
        Metric::Requests => format!("{value} requests"),
        Metric::Failed => format!("{value} failed"),
        Metric::Tokens => format!("{value} tokens"),
        Metric::Cost => value,
    }
}

fn trend(view: &PanelView, usage: &Usage, now: i64, cx: &Context<PanelView>) -> impl IntoElement {
    let theme = cx.theme();
    let offset = local_utc_offset(now);
    let values: Vec<u128> = usage.buckets.iter().map(|b| slice_value(&b.slice, view.metric)).collect();
    let max = values.iter().copied().max().unwrap_or(0);
    let last = values.len().checked_sub(1);
    let selected = view.bar.filter(|&i| i < values.len()).or(last);
    let label = |i: usize| bucket_label(&usage.buckets[i].start, usage.bucket_unit, usage.range, offset);
    let per = match usage.bucket_unit {
        BucketUnit::Hour => "per hour",
        BucketUnit::Day => "per day",
    };
    let caption = selected.map(|i| format!("{} · {} ({per})", label(i), value_words(values[i], view.metric)));
    let bars = h_flex().h(px(96.)).items_end().gap(px(2.)).children(values.iter().enumerate().map(|(i, &value)| {
        let fraction = if max == 0 { 0.0 } else { value as f32 / max as f32 };
        div()
            .id(("bar", i))
            .flex_1()
            .h_full()
            .flex()
            .items_end()
            .cursor_pointer()
            .child(div().w_full().h(relative(fraction)).rounded_t(px(1.)).bg(if selected == Some(i) {
                theme.foreground
            } else {
                theme.chart_1
            }))
            .on_click(cx.listener(move |view, _, _, cx| {
                view.bar = Some(i);
                cx.notify();
            }))
    }));
    let axis = last.map(|last| {
        h_flex()
            .justify_between()
            .text_size(px(10.))
            .text_color(theme.muted_foreground)
            .child(label(0))
            .child(label(last / 2))
            .child(label(last))
    });
    v_flex().gap_1().pt_2().children(caption.map(|text| div().text_xs().child(text))).child(bars).children(axis)
}

fn section_label(text: &'static str, cx: &App) -> Div {
    div().pt_3().pb_1().text_size(px(10.)).text_color(cx.theme().muted_foreground).child(text)
}

/// Name, share bar and value per row; `empty` when every value is 0.
fn breakdown(rows: Vec<(String, u128, f64)>, metric: Metric, empty: &'static str, cx: &App) -> AnyElement {
    let theme = cx.theme();
    if rows.iter().all(|row| row.1 == 0) {
        return div().text_xs().text_color(theme.muted_foreground).child(empty).into_any_element();
    }
    v_flex()
        .gap(px(3.))
        .children(rows.into_iter().map(|(name, value, share)| {
            h_flex()
                .gap_2()
                .items_center()
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_size(px(11.))
                        .font_family(theme.mono_font_family.clone())
                        .child(name),
                )
                .child(
                    div()
                        .w(px(76.))
                        .flex_shrink_0()
                        .h(px(4.))
                        .rounded_full()
                        .bg(theme.muted)
                        .child(div().h_full().w(relative(share as f32)).rounded_full().bg(theme.chart_1)),
                )
                .child(
                    div().w(px(52.)).flex_shrink_0().text_right().text_size(px(11.)).child(format_value(value, metric)),
                )
        }))
        .into_any_element()
}

pub fn usage(view: &PanelView, model: &AppModel, now: i64, cx: &Context<PanelView>) -> impl IntoElement {
    let theme = cx.theme();
    let usage = model.usage_for(model.usage_range);
    let cards = h_flex().gap(px(5.)).children(Metric::ALL.map(|metric| card(view, usage, metric, cx)));
    let group = v_flex().pb_3().child(header(model, cx)).child(cards);
    let Some(usage) = usage else {
        // No response for this window yet: the skeleton, or why the first fetch failed.
        let text = model.usage_error().unwrap_or("Loading…").to_string();
        return group.child(div().pt_2().text_xs().text_color(theme.muted_foreground).child(text));
    };
    let metric = view.metric;
    let total = metric_total(&usage.current, metric);
    let models = ranked(&usage.by_model, |m| &m.slice, metric, total, Some(5))
        .into_iter()
        .map(|(m, value, share)| (m.model_id.clone(), value, share))
        .collect();
    let providers = ranked(&usage.by_provider, |p| &p.slice, metric, total, None)
        .into_iter()
        .map(|(p, value, share)| (p.name.clone(), value, share))
        .collect();
    // Spans pruned under live traffic: there is usage, but no Provider split for it.
    let providers_empty = if usage.by_provider.is_empty() && usage.current.requests > 0 {
        "No per-Provider data for this window"
    } else {
        metric.empty_text()
    };
    group
        .child(
            div()
                .pt_1()
                .text_size(px(10.))
                .text_color(theme.muted_foreground)
                .child(format!("Compared with the previous {}", model.usage_range.label())),
        )
        .child(trend(view, usage, now, cx))
        .child(section_label("TOP MODELS", cx))
        .child(breakdown(models, metric, metric.empty_text(), cx))
        .child(section_label("BY PROVIDER", cx))
        .child(breakdown(providers, metric, providers_empty, cx))
}
