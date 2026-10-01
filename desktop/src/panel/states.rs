//! The body when there are no groups to show: stopped, not responding, degraded, rejected,
//! unreachable or loading.

use gpui_kit::component::*;
use gpui_kit::*;

use super::{degraded, status};
use crate::app::{AppModel, SummaryState};

pub fn body(model: &AppModel, cx: &App) -> impl IntoElement {
    let text: String = match &model.summary {
        // A down proxy may leave its last summary in the model; it is not shown.
        _ if status::is_stopped(model) => "The proxy is not running. It stays stopped until you start it.".into(),
        _ if status::is_down(model) => {
            "aio-proxy is not responding. Restart it from the menu-bar icon's right-click menu.".into()
        }
        SummaryState::Degraded(reason) => return div().flex_1().px_3().child(degraded::body(reason)),
        SummaryState::AuthFailed => "Authentication failed. The desktop token was rejected.".into(),
        SummaryState::Unavailable(error) => error.clone(),
        SummaryState::Waiting | SummaryState::Ready(_) => "Loading…".into(),
    };
    div().flex_1().px_3().child(div().py_2().text_sm().text_color(cx.theme().muted_foreground).child(text))
}
