//! The tray PopUp: beside the notification-area icon, on the acrylic flyout backdrop where it renders,
//! closed by click-away. GPUI gives a PopUp `WS_EX_TOOLWINDOW`, so it has no taskbar button.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use gpui_kit::*;
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Dwm::{
    DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE, DwmExtendFrameIntoClientArea, DwmSetWindowAttribute,
};
use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromRect};
use windows_sys::Win32::UI::Controls::MARGINS;
use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};

use crate::log;
use crate::panel::backdrop::{Backdrop, backdrop_choice};
use crate::panel::placement::{Rect, popup_origin, to_logical};
use crate::panel::{PANEL_HEIGHT, PANEL_WIDTH};
use crate::tray::Tray;

/// The icon rect (physical pixels) from the last tray click. Kept from the click itself: an icon in
/// the overflow flyout has no rect once the flyout closes.
static LAST_CLICK: Mutex<Option<RECT>> = Mutex::new(None);
/// Whether the window being opened asked for the acrylic backdrop, for `after_open`.
static ACRYLIC: AtomicBool = AtomicBool::new(false);

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
    ACRYLIC.store(false, Ordering::Relaxed);
    let Some((x, y, display)) = icon.and_then(anchor) else {
        // Nothing to anchor to yet (no click so far): an ordinary centered window.
        log::info("panel: no tray icon rect; centering the window");
        return Some(WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size, cx))),
            kind: WindowKind::Normal,
            ..Default::default()
        });
    };
    let backdrop = backdrop_choice(build(), transparency(), software_adapter());
    let window_background = match backdrop {
        // GPUI has no acrylic: its Mica option sets the same DWM attribute (changed in `after_open`),
        // clears the frame to transparent, and leaves out the accent-policy blur that renders black.
        Backdrop::Acrylic => WindowBackgroundAppearance::MicaBackdrop,
        Backdrop::Opaque(reason) => {
            log::info(format!("panel: backdrop opaque ({reason})"));
            WindowBackgroundAppearance::Opaque
        }
    };
    ACRYLIC.store(backdrop == Backdrop::Acrylic, Ordering::Relaxed);
    Some(WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds { origin: point(px(x as f32), px(y as f32)), size })),
        titlebar: None,
        focus: true,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        window_background,
        display_id: Some(display),
        ..Default::default()
    })
}

/// Puts the acrylic backdrop under the cleared root. Should DWM refuse it, the root gets the theme's
/// fill back, so the panel never shows an empty (black) frame under its text.
pub fn after_open(handle: AnyWindowHandle, cx: &mut App) {
    if !ACRYLIC.load(Ordering::Relaxed) {
        return;
    }
    let Ok(Some(hwnd)) = handle.update(cx, |_, window, _| native_window(window)) else { return };
    match acrylic(hwnd) {
        Ok(()) => log::info("panel: backdrop acrylic"),
        Err(code) => {
            log::info(format!("panel: backdrop opaque (DWM refused it: {code:#010x})"));
            let _ = handle.update(cx, |_, window, cx| {
                if let Some(Some(root)) = window.root::<gpui_kit::base::Root>() {
                    root.update(cx, |root, cx| {
                        root.style().background = None;
                        cx.notify();
                    });
                }
            });
        }
    }
}

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

/// The flyout material (`DWMSBT_TRANSIENTWINDOW`), which DWM tints for the light or dark mode GPUI
/// already sets on the window. The frame is extended over the whole client area so the backdrop
/// draws behind GPUI's transparent pixels, not only behind a (here absent) frame.
fn acrylic(hwnd: HWND) -> Result<(), i32> {
    let margins = MARGINS { cxLeftWidth: -1, cxRightWidth: -1, cyTopHeight: -1, cyBottomHeight: -1 };
    let backdrop = DWMSBT_TRANSIENTWINDOW;
    // SAFETY: `hwnd` is the panel's live window; both pointers are to live locals of the sizes passed.
    let results = unsafe {
        [
            DwmExtendFrameIntoClientArea(hwnd, &margins),
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE as u32,
                (&raw const backdrop).cast(),
                size_of_val(&backdrop) as u32,
            ),
        ]
    };
    results.into_iter().find(|hr| *hr < 0).map_or(Ok(()), Err)
}

/// The OS build, or 0 when unreadable.
fn build() -> u32 {
    windows_registry::LOCAL_MACHINE
        .open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        .and_then(|key| key.get_string("CurrentBuildNumber"))
        .ok()
        .and_then(|build| build.trim().parse().ok())
        .unwrap_or(0)
}

/// Settings > Personalization > Colors > Transparency effects; absent until first toggled.
fn transparency() -> Option<u32> {
    windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_u32("EnableTransparency"))
        .ok()
}

/// Whether the primary adapter is WARP (the Microsoft Basic Render Driver), as in a VM without GPU
/// acceleration; no adapter at all counts too.
fn software_adapter() -> bool {
    // `::`: the crate, not the `platform::windows` module this file sits in.
    use ::windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIFactory1};
    // SAFETY: plain DXGI calls on COM objects owned (and released) here; DXGI needs no COM init.
    let desc =
        unsafe { CreateDXGIFactory1::<IDXGIFactory1>().and_then(|f| f.EnumAdapters1(0)).and_then(|a| a.GetDesc1()) };
    match desc {
        Ok(d) => (d.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 || (d.VendorId == 0x1414 && d.DeviceId == 0x8c),
        Err(_) => true,
    }
}

/// The HWND GPUI created, reached through the public raw-window-handle.
fn native_window(window: &Window) -> Option<HWND> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let RawWindowHandle::Win32(handle) = HasWindowHandle::window_handle(window).ok()?.as_raw() else {
        return None;
    };
    Some(handle.hwnd.get() as HWND)
}
