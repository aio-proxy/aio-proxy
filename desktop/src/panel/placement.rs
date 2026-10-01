//! Where the panel goes: below the menu bar, centred on the icon, clamped to the icon's screen.

/// A rectangle in AppKit global points (origin bottom-left, y up).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// The panel's top-left in the screen's own top-down points, as GPUI's `display_id` bounds expect.
/// `status_window` is the status item button's window frame; `screen` is that window's screen.
pub fn panel_origin(status_window: Frame, screen: Frame, panel_width: f64) -> (f64, f64) {
    let anchor = status_window.x + status_window.width / 2.0;
    let max_left = (screen.x + screen.width - panel_width).max(screen.x);
    let left = (anchor - panel_width / 2.0).min(max_left).max(screen.x);
    // Rounded: AppKit turns a .5 origin into a 1-pt-wider window.
    let x = (left - screen.x).round();
    let y = (screen.y + screen.height) - status_window.y;
    (x, y)
}

#[cfg(test)]
mod tests;
