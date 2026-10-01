//! The gentle update reminder. Task 9 rewrites the footer.

use gpui_kit::component::button::*;
use gpui_kit::component::*;
use gpui_kit::*;

use crate::app::AppModel;

/// `None` when there is nothing to show: a pending Sparkle update is shown wherever the app runs from.
pub fn footer(model: &AppModel, cx: &App) -> Option<impl IntoElement> {
    let version = model.update_pending.as_ref()?;
    Some(
        v_flex().gap_1().text_color(cx.theme().foreground).child(
            Button::new("update")
                .small()
                .primary()
                .label(format!("Update to {version}…"))
                .on_click(|_, _, _| crate::updater::check_now()),
        ),
    )
}
