//! The Provider list: state, diagnostic and one progress bar per quota window.

use gpui_kit::component::progress::Progress;
use gpui_kit::component::*;
use gpui_kit::*;

use super::format::{parse_utc, percent, until};
use crate::summary::{Provider, ProviderState, Quota, QuotaWindow};

pub fn quota_text(window: &QuotaWindow, now: i64) -> String {
    let mut text = window.label.text().to_string();
    match window.remaining_ratio {
        Some(ratio) => text.push_str(&format!(" · {} left", percent(ratio))),
        None => text.push_str(" · no data"),
    }
    if let Some(at) = window.resets_at.as_deref().and_then(parse_utc) {
        text.push_str(&format!(" · resets {}", until(now, at)));
    }
    text
}

pub fn quota_status(quota: &Quota) -> Option<&'static str> {
    match quota {
        Quota::Loading => Some("Quota loading…"),
        Quota::Failed => Some("Quota unavailable"),
        Quota::Ready { refresh_failed: true, .. } => Some("Quota refresh failed; showing the last reading"),
        Quota::Unknown => Some("Quota status not recognised"),
        Quota::None | Quota::Unsupported | Quota::Ready { .. } => None,
    }
}

fn state_color(state: ProviderState, cx: &App) -> Hsla {
    match state {
        ProviderState::Ok => cx.theme().success,
        ProviderState::Degraded => cx.theme().warning,
        ProviderState::Unavailable => cx.theme().danger,
        ProviderState::Disabled | ProviderState::Unknown => cx.theme().muted_foreground,
    }
}

fn row(provider: &Provider, now: i64, cx: &App) -> impl IntoElement {
    let muted = cx.theme().muted_foreground;
    let mut column = v_flex().py_1().gap_1().border_b_1().border_color(cx.theme().border).child(
        h_flex()
            .gap_2()
            .items_center()
            .child(div().size(px(8.)).rounded_full().bg(state_color(provider.state, cx)))
            .child(div().text_sm().child(provider.name.clone())),
    );
    if let Some(diagnostic) = &provider.diagnostic {
        column = column.child(div().text_xs().text_color(muted).child(diagnostic.summary.clone()));
    }
    if let Some(status) = quota_status(&provider.quota) {
        column = column.child(div().text_xs().text_color(muted).child(status));
    }
    if let Quota::Ready { windows, .. } = &provider.quota {
        for window in windows {
            let id: SharedString = format!("quota-{}-{}", provider.id, window.id).into();
            column = column
                .child(div().text_xs().text_color(muted).child(quota_text(window, now)))
                .child(Progress::new(id).value(window.remaining_ratio.unwrap_or(0.0) as f32 * 100.0));
        }
    }
    column
}

pub fn list(providers: &[Provider], now: i64, cx: &App) -> impl IntoElement {
    div().id("providers").flex_1().overflow_y_scroll().children(providers.iter().map(|p| row(p, now, cx)))
}

#[cfg(test)]
mod tests;
