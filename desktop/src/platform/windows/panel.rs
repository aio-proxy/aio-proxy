//! The tray PopUp: beside the notification-area icon, blurred, closed by click-away. GPUI gives a
//! PopUp `WS_EX_TOOLWINDOW`, so it has no taskbar button.

use std::sync::Mutex;

use gpui_kit::*;
use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect};
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use crate::log;
use crate::panel::placement::{Rect, popup_origin, to_logical};
use crate::panel::{PANEL_HEIGHT, PANEL_WIDTH};
use crate::tray::Tray;

/// The icon rect (physical pixels) from the last tray click. Kept from the click itself: an icon in
/// the overflow flyout has no rect once the flyout closes.
static LAST_CLICK: Mutex<Option<RECT>> = Mutex::new(None);

pub fn remember_click(rect: tray_icon::Rect) {
    let (x, y) = (rect.position.x as i32, rect.position.y as i32);
    let (width, height) = (rect.size.width as i32, rect.size.height as i32);
    if let Ok(mut last) = LAST_CLICK.lock() {
        *last = Some(RECT { left: x, top: y, right: x + width, bottom: y + height });
    }
}

pub fn window_options(cx: &App, _tray: Option<&Tray>) -> Option<WindowOptions> {
    let size = size(px(PANEL_WIDTH as f32), px(PANEL_HEIGHT as f32));
    let icon = LAST_CLICK.lock().ok().and_then(|last| *last);
    let Some((x, y, display)) = icon.and_then(anchor) else {
        // Nothing to anchor to yet (no click so far): an ordinary centered window.
        log::info("panel: no tray icon rect; centering the window");
        return Some(WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size, cx))),
            kind: WindowKind::Normal,
            ..Default::default()
        });
    };
    Some(WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds { origin: point(px(x as f32), px(y as f32)), size })),
        titlebar: None,
        focus: true,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        window_background: WindowBackgroundAppearance::Blurred,
        display_id: Some(display),
        ..Default::default()
    })
}

pub fn after_open(_handle: AnyWindowHandle, _cx: &mut App) {}

pub fn closes_on_deactivate() -> bool {
    true
}

/// The panel's origin in GPUI's global logical pixels (physical / the monitor's scale), and the
/// icon's monitor, whose `HMONITOR` is GPUI's Windows display id.
fn anchor(icon: RECT) -> Option<(f64, f64, DisplayId)> {
    let mut info = MONITORINFO { cbSize: size_of::<MONITORINFO>() as u32, ..Default::default() };
    let (mut dpi, mut dpi_y) = (0, 0);
    // SAFETY: `icon` and `info` are live locals; `info.cbSize` is set as GetMonitorInfoW requires.
    let monitor = unsafe {
        let monitor = MonitorFromRect(&icon, MONITOR_DEFAULTTONEAREST);
        if GetMonitorInfoW(monitor, &mut info) == 0
            || GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi, &mut dpi_y) < 0
        {
            return None;
        }
        monitor
    };
    let scale = f64::from(dpi) / 96.0;
    let rect = |r: RECT| Rect {
        x: f64::from(r.left),
        y: f64::from(r.top),
        width: f64::from(r.right - r.left),
        height: f64::from(r.bottom - r.top),
    };
    let (x, y) =
        popup_origin(to_logical(rect(icon), scale), to_logical(rect(info.rcWork), scale), (PANEL_WIDTH, PANEL_HEIGHT));
    Some((x, y, DisplayId::new(monitor as u64)))
}
