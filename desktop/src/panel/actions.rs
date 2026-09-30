//! The action row. Buttons only appear when the ownership table offers them.

use gpui_kit::component::button::*;
use gpui_kit::component::*;
use gpui_kit::*;

use crate::app::{self, AppModel};
use crate::connect::policy::{UserAction, offered_actions};

fn action_button(id: &'static str, label: &'static str, action: UserAction, busy: bool) -> Button {
    Button::new(id).small().label(label).disabled(busy).on_click(move |_, _, cx| app::run_user_action(cx, action))
}

pub fn row(model: &AppModel) -> impl IntoElement {
    let busy = model.action.is_busy();
    let offered = model.discovery.as_ref().map(|d| offered_actions(d, model.persistent())).unwrap_or_default();
    let mut row = h_flex().gap_1().flex_wrap();
    if offered.install {
        row = row.child(action_button("install", "Install and start", UserAction::InstallAndStart, busy));
    }
    if offered.start {
        row = row.child(action_button("start", "Start", UserAction::Start, busy));
    }
    if offered.restart {
        row = row.child(action_button("restart", "Restart", UserAction::Restart, busy));
    }
    if offered.stop {
        row = row.child(action_button("stop", "Stop", UserAction::Stop, busy));
    }
    if offered.reload {
        row = row.child(action_button("reload", "Reload config", UserAction::Reload, busy));
    }
    row.child(Button::new("refresh").small().label("Refresh").on_click(|_, _, cx| app::manual_refresh(cx)))
        .child(Button::new("logs").small().label("Open logs").on_click(|_, _, cx| app::open_logs(cx)))
        .child(
            Button::new("dashboard")
                .small()
                .primary()
                .label("Open Dashboard")
                .on_click(|_, _, cx| app::open_dashboard(cx)),
        )
}
