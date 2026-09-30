//! The panel for an instance without a usable `desktop-summary` (404, or an unknown protocolVersion):
//! status, endpoint, Open Dashboard, Reload.

use gpui_kit::*;

use crate::summary::DegradedReason;

pub fn body(reason: &DegradedReason) -> impl IntoElement {
    let text = match reason {
        DegradedReason::Missing => {
            "This aio-proxy is older than the desktop app and has no summary. Update it to see usage."
        }
        DegradedReason::UnsupportedVersion(_) => {
            "This aio-proxy speaks a newer summary format. Update the desktop app to see usage."
        }
    };
    div().py_2().text_sm().child(text)
}
