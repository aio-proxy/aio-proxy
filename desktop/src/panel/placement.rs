//! Where the panel goes: below the macOS menu bar, or beside the Windows tray icon, centred on the
//! icon and clamped to the icon's screen.

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

/// A rectangle in top-down pixels (origin top-left, y down), as Win32 reports them.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Win32 rects are physical pixels; GPUI places windows in logical ones.
pub fn to_logical(r: Rect, scale: f64) -> Rect {
    Rect { x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale }
}

/// The popup's top-left beside the tray `icon`, all in logical pixels. The taskbar is on the side of
/// `icon` outside `work_area`: the popup sits flush against that edge of the work area, centred on
/// the icon along it. An icon inside the work area (the overflow flyout) opens the popup above itself
/// in the lower half of the work area, else below. Always clamped inside the work area.
pub fn popup_origin(icon: Rect, work_area: Rect, (width, height): (f64, f64)) -> (f64, f64) {
    let (left, top) = (work_area.x, work_area.y);
    let (right, bottom) = (left + work_area.width, top + work_area.height);
    // min-then-max, not `clamp`: a work area smaller than the popup pins it to the top-left.
    let clamp_x = |x: f64| x.min(right - width).max(left);
    let clamp_y = |y: f64| y.min(bottom - height).max(top);
    let centred_x = clamp_x(icon.x + icon.width / 2.0 - width / 2.0);
    let centred_y = clamp_y(icon.y + icon.height / 2.0 - height / 2.0);
    if icon.y >= bottom {
        (centred_x, clamp_y(bottom - height))
    } else if icon.y + icon.height <= top {
        (centred_x, top)
    } else if icon.x + icon.width <= left {
        (left, centred_y)
    } else if icon.x >= right {
        (clamp_x(right - width), centred_y)
    } else if icon.y + icon.height / 2.0 > top + work_area.height / 2.0 {
        (centred_x, clamp_y(icon.y - height))
    } else {
        (centred_x, clamp_y(icon.y + icon.height))
    }
}

#[cfg(test)]
mod tests;
