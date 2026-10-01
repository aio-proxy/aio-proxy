//! Status, endpoint, one alert line with Show, one notice line, and at most one promoted action.

use gpui_kit::component::button::*;
use gpui_kit::component::*;
use gpui_kit::*;

use super::status;
use crate::app::{self, AppModel, SummaryState};
use crate::connect::policy::{UserAction, offered_actions};

/// The single state-relevant action: Start when stopped, Install and start when a fresh install is offered.
fn promoted(model: &AppModel) -> Option<(UserAction, &'static str)> {
    let offered = offered_actions(model.discovery.as_ref()?, model.persistent());
    if offered.install {
        Some((UserAction::InstallAndStart, "Install and start"))
    } else if offered.start {
        Some((UserAction::Start, "Start"))
    } else {
        None
    }
}

/// `on_show` scrolls to the Quota group; it runs only when the alerting Provider is listed there.
pub fn header(
    model: &AppModel,
    quota_ids: &[String],
    on_show: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme();
    let mut line = h_flex()
        .gap_2()
        .items_center()
        .child(div().size(px(8.)).rounded_full().bg(status::dot(model, cx)))
        .child(div().flex_1().text_base().font_semibold().child(status::headline(model)));
    if let Some((action, label)) = promoted(model) {
        line = line.child(
            Button::new("promoted")
                .small()
                .primary()
                .label(label)
                .disabled(model.action.is_busy())
                .on_click(move |_, _, cx| app::run_user_action(cx, action)),
        );
    }
    let mut column = v_flex().px_3().pt_3().gap(px(2.)).child(line);
    if let Some(endpoint) = status::endpoint_line(model) {
        column = column.child(
            div()
                .text_xs()
                .text_color(theme.muted_foreground)
                .font_family(theme.mono_font_family.clone())
                .child(endpoint),
        );
    }
    // A stopped proxy's last summary is stale: its alerts are not shown.
    if let SummaryState::Ready(summary) = &model.summary
        && !status::is_stopped(model)
        && let Some(first) = summary.alerts.first()
    {
        let more = summary.alerts.len() - 1;
        let text = if more > 0 { format!("{} · +{more} more", first.message) } else { first.message.clone() };
        let in_quota = quota_ids.contains(&first.provider_id);
        column = column.child(
            h_flex().gap_1().text_xs().text_color(theme.danger).child(div().min_w_0().truncate().child(text)).child(
                div().id("alert-show").flex_shrink_0().underline().cursor_pointer().child("Show").on_click(
                    move |event, window, cx| {
                        if in_quota {
                            on_show(event, window, cx);
                        } else {
                            app::open_dashboard_providers(cx);
                        }
                    },
                ),
            ),
        );
    }
    if let Some(notice) = status::notice(model) {
        column = column.child(div().text_xs().text_color(theme.muted_foreground).child(notice));
    }
    column
}
