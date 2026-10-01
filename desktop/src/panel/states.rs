//! The body when there are no groups to show: stopped, not responding, degraded, rejected,
//! unreachable or loading.

use gpui_kit::assets::IconName as Lucide;
use gpui_kit::component::button::*;
use gpui_kit::component::empty::{
    Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyMediaVariant, EmptyTitle,
};
use gpui_kit::component::*;
use gpui_kit::*;

use super::{degraded, status};
use crate::app::{self, AppModel, SummaryState};
use crate::connect::policy::{UserAction, offered_actions};

/// The one action that gets a down proxy going: Install and start when a fresh install is offered,
/// Take over when the CLI that installed the service is gone, else Start. Every other action lives
/// in the menus.
fn action(model: &AppModel) -> Option<(UserAction, &'static str)> {
    let offered = offered_actions(model.discovery.as_ref()?, model.persistent());
    if offered.install {
        Some((UserAction::InstallAndStart, "Install and start"))
    } else if offered.take_over {
        Some((UserAction::TakeOver, "Take over and start"))
    } else if offered.start {
        Some((UserAction::Start, "Start"))
    } else {
        None
    }
}

/// A down proxy: an empty state whose button is the action that starts it.
fn down(model: &AppModel) -> Empty {
    let (icon, title, description) = if status::is_orphaned(model) {
        (
            Lucide::Unplug,
            "Its CLI was uninstalled",
            "The aio-proxy CLI that ran this service is gone. Take it over to run it from AIO Proxy, with the same config.",
        )
    } else if status::is_stopped(model) {
        (Lucide::PowerOff, "The proxy is not running", "It stays stopped until you start it.")
    } else {
        (
            Lucide::ServerOff,
            "aio-proxy is not responding",
            "Restart it from the ⋯ menu or the menu-bar icon's right-click menu.",
        )
    };
    let empty = Empty::new().header(
        EmptyHeader::new()
            .media(EmptyMedia::new().with_variant(EmptyMediaVariant::Icon).child(Icon::new(icon)))
            .title(EmptyTitle::new().child(title))
            .description(EmptyDescription::new().child(description)),
    );
    match action(model) {
        Some((action, label)) => empty.content(
            EmptyContent::new().child(
                Button::new("start")
                    .small()
                    .primary()
                    .label(label)
                    .loading(model.action.is_busy())
                    .disabled(model.action.is_busy())
                    .on_click(move |_, _, cx| app::run_user_action(cx, action)),
            ),
        ),
        None => empty,
    }
}

pub fn body(model: &AppModel, cx: &App) -> impl IntoElement {
    let text: String = match &model.summary {
        // A down proxy may leave its last summary in the model; it is not shown.
        _ if status::is_down(model) => return div().flex_1().px_5().flex().items_center().child(down(model)),
        SummaryState::Degraded(reason) => return div().flex_1().px_5().child(degraded::body(reason)),
        SummaryState::AuthFailed => "Authentication failed. The desktop token was rejected.".into(),
        SummaryState::Unavailable(error) => error.clone(),
        SummaryState::Waiting | SummaryState::Ready(_) => "Loading…".into(),
    };
    div()
        .flex_1()
        .px_5()
        .child(div().py_2().text_sm().text_color(crate::theme::colors(cx).muted_foreground).child(text))
}
