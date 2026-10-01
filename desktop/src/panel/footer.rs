//! Open Dashboard, the update reminder next to it, and the last refresh time (a click refreshes).

use gpui_kit::component::button::*;
use gpui_kit::component::*;
use gpui_kit::*;

use super::status;
use crate::app::{self, AppModel, SummaryState};

pub fn footer(model: &AppModel, cx: &App) -> impl IntoElement {
    let theme = cx.theme();
    let mut row = h_flex().gap_2().items_center().px_3().py_2().border_t_1().border_color(theme.border).child(
        Button::new("dashboard").small().primary().label("Open Dashboard").on_click(|_, _, cx| app::open_dashboard(cx)),
    );
    if let Some(version) = &model.update_pending {
        row = row.child(
            Button::new("update")
                .small()
                .label(format!("Update to {version}…"))
                .on_click(|_, _, _| crate::updater::check_now()),
        );
    }
    let shown = matches!(model.summary, SummaryState::Ready(_)) && !status::is_down(model);
    let updated = shown.then(|| model.updated_text()).flatten();
    row.child(div().flex_1()).children(updated.map(|text| {
        div()
            .id("refresh")
            .text_xs()
            .text_color(theme.muted_foreground)
            .cursor_pointer()
            .child(text)
            .on_click(|_, _, cx| app::manual_refresh(cx))
    }))
}
