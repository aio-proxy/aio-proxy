//! Launch-at-login switch and the gentle update reminder.

use gpui_kit::component::button::*;
use gpui_kit::component::switch::Switch;
use gpui_kit::component::*;
use gpui_kit::*;

use crate::app::{self, AppModel};
use crate::login_item::{self, LoginItemStatus};

/// `None` when there is nothing to show: the switch needs a persistent install (otherwise it would
/// do nothing), but a pending Sparkle update is shown wherever the app runs from.
pub fn footer(model: &AppModel, cx: &App) -> Option<impl IntoElement> {
    let persistent = model.persistent();
    if !persistent && model.update_pending.is_none() {
        return None;
    }
    let mut column = v_flex().gap_1().text_color(cx.theme().foreground);
    if persistent {
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
        column = column.child(login);
        if let Some(error) = &model.login_item_error {
            column = column.child(div().text_xs().text_color(cx.theme().danger).child(error.clone()));
        }
    }
    if let Some(version) = &model.update_pending {
        column = column.child(
            Button::new("update")
                .small()
                .primary()
                .label(format!("Update to {version}…"))
                .on_click(|_, _, _| crate::updater::check_now()),
        );
    }
    Some(column)
}
