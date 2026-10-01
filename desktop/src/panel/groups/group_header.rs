//! The title row every group starts with; the sticky overlay repeats it.

use gpui_kit::component::*;
use gpui_kit::*;

pub fn group_header(title: &'static str, right: impl IntoElement) -> Div {
    h_flex()
        .justify_between()
        .items_center()
        .gap_2()
        .py(px(8.))
        .child(div().text_size(px(12.)).font_semibold().child(title))
        .child(right)
}
