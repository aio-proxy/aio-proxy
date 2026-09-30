//! The panel's root view. It holds no data: everything renders from the `AppModel` global.

use std::time::{SystemTime, UNIX_EPOCH};

use gpui_kit::component::*;
use gpui_kit::*;

use super::format::{compact, usd};
use super::{actions, charts, degraded, footer, providers, status};
use crate::app::{AppModel, SummaryState};
use crate::summary::SummaryV1;

pub struct PanelView {
    _activation: Subscription,
}

impl PanelView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Click-away closes the panel (passed by hand on 2026-09-30, spike check 2 item 1).
        let activation = cx.observe_window_activation(window, |_, window, cx| {
            if !window.is_window_active() {
                super::window::close(window, cx);
            }
        });
        Self { _activation: activation }
    }
}

fn card(label: &'static str, value: String, cx: &App) -> impl IntoElement {
    v_flex()
        .flex_1()
        .p_2()
        .rounded_md()
        .border_1()
        .border_color(cx.theme().border)
        .child(div().text_xs().text_color(cx.theme().muted_foreground).child(label))
        .child(div().text_lg().child(value))
}

fn cards(summary: &SummaryV1, cx: &App) -> impl IntoElement {
    let usage = &summary.usage24h;
    h_flex()
        .gap_2()
        .child(card("Requests 24h", compact(usage.requests), cx))
        .child(card("Failed", compact(usage.failed_requests), cx))
        .child(card("Tokens", compact(usage.input_tokens + usage.output_tokens), cx))
        .child(card("Cost", usd(usage.estimated_cost_nano_usd), cx))
}

fn body(model: &AppModel, now: i64, cx: &App) -> AnyElement {
    let muted = cx.theme().muted_foreground;
    let message = |text: String| div().py_2().text_sm().text_color(muted).child(text).into_any_element();
    match &model.summary {
        SummaryState::Ready(summary) => v_flex()
            .flex_1()
            .gap_2()
            .child(cards(summary, cx))
            .child(charts::trend(&summary.trend7d, now, cx))
            .child(charts::heatmap(&summary.activity, now, cx))
            .child(providers::list(&summary.providers, now, cx))
            .into_any_element(),
        SummaryState::Degraded(reason) => degraded::body(reason).into_any_element(),
        SummaryState::AuthFailed => message("Authentication failed. The desktop token was rejected.".into()),
        SummaryState::Unavailable(error) => message(error.clone()),
        SummaryState::Waiting => message("Loading…".into()),
    }
}

impl Render for PanelView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64);
        let model = cx.global::<AppModel>();
        let muted = cx.theme().muted_foreground;
        let mut header = v_flex().gap_1().child(div().text_lg().child(status::headline(model)));
        if let Some(endpoint) = status::endpoint(model) {
            header = header.child(div().text_xs().text_color(muted).child(endpoint));
        }
        if let Some(notice) = status::notice(model) {
            header = header.child(div().text_xs().child(notice));
        }
        v_flex()
            .size_full()
            .p_3()
            .gap_2()
            .bg(cx.theme().background)
            .child(header)
            .child(body(model, now, cx))
            .child(actions::row(model))
            .child(footer::footer(model, cx))
    }
}
