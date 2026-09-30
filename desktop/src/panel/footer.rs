//! Launch-at-login switch. Task 14 adds the gentle update reminder.

use gpui_kit::component::button::*;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::*;
use gpui_kit::*;

use crate::app::{self, AppModel};
use crate::login_item::{self, LoginItemStatus};

pub fn footer(model: &AppModel, cx: &App) -> impl IntoElement {
    let mut row = h_flex().gap_2().items_center().justify_between();
    if model.persistent() {
        let enabled = matches!(model.login_item, LoginItemStatus::Enabled | LoginItemStatus::RequiresApproval);
        let mut login = h_flex().gap_1().items_center().child(
            Switch::new("login-item")
                .checked(enabled)
                .label("Open at login")
                .on_click(|checked, _, cx| app::set_login_item(cx, *checked)),
        );
        if model.login_item == LoginItemStatus::RequiresApproval {
            login = login.child(
                Button::new("login-approve")
                    .xsmall()
                    .ghost()
                    .label("Needs approval in System Settings")
                    .on_click(|_, _, _| login_item::open_settings()),
            );
        }
        row = row.child(login);
    }
    row.text_color(cx.theme().foreground)
}
