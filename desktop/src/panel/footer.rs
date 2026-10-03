//! Open Dashboard (while the proxy is up), the update reminder next to it, and the `⋯` menu: the
//! right-click menu's entries, for a user in the panel.

use gpui_kit::component::button::*;
use gpui_kit::component::menu::{DropdownMenu, PopupMenuItem};
use gpui_kit::component::*;
use gpui_kit::*;

use super::status;
use crate::app::{self, AppModel};
use crate::tray::{self, MenuEntry};

pub fn footer(model: &AppModel) -> impl IntoElement {
    let mut row = h_flex()
        .gap_2()
        .items_center()
        // The content inset (`px_5`) less each end button's own padding, so the button's label
        // and the `⋯` glyph line up with the cards' text and chevrons.
        .pl_3()
        .pr_4()
        .py_2();
    // A down proxy serves no Dashboard; the body's empty state carries the button that starts it.
    if !status::is_down(model) {
        row = row.child(
            Button::new("dashboard")
                .small()
                .primary()
                .label("Open Dashboard")
                .on_click(|_, _, cx| app::open_dashboard(cx)),
        );
    }
    if let Some(version) = &model.update_pending {
        row = row.child(
            Button::new("update")
                .small()
                .label(format!("Update to {version}…"))
                .on_click(|_, _, _| crate::platform::updater::install_now()),
        );
    }
    let more = Button::new("more").ghost().small().icon(IconName::Ellipsis).dropdown_menu_with_anchor(
        // Opens upward from the footer, right edges aligned.
        Anchor::BottomRight,
        |menu, _, cx| {
            tray::entries(cx.global::<AppModel>()).into_iter().fold(menu, |menu, entry| match entry {
                MenuEntry::Separator => menu.separator(),
                MenuEntry::Item { command, label, enabled } => menu.item(
                    PopupMenuItem::new(label).disabled(!enabled).on_click(move |_, _, cx| tray::run(cx, command)),
                ),
                MenuEntry::Check { command, label, checked, enabled } => menu.item(
                    PopupMenuItem::new(label)
                        .checked(checked)
                        .disabled(!enabled)
                        .on_click(move |_, _, cx| tray::run(cx, command)),
                ),
            })
        },
    );
    row.child(div().flex_1()).child(more)
}
