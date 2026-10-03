//! An ordinary window the window manager places: there is no icon rect to anchor to, and GNOME may
//! have no tray at all. The app draws its own title bar (see `PanelView`).

use gpui_kit::component::TitleBar;
use gpui_kit::*;

use crate::panel::{PANEL_HEIGHT, PANEL_WIDTH};
use crate::tray::Tray;

pub fn window_options(cx: &App, _tray: Option<&Tray>) -> Option<WindowOptions> {
    let size = size(px(PANEL_WIDTH as f32), px(PANEL_HEIGHT as f32));
    Some(WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size, cx))),
        kind: WindowKind::Normal,
        // Wayland ignores this and keeps only the minimum size.
        is_resizable: true,
        window_min_size: Some(size),
        // GPUI falls back to server decorations where the compositor insists; the title bar then
        // drops its window controls.
        window_decorations: Some(WindowDecorations::Client),
        window_background: WindowBackgroundAppearance::Opaque,
        // WM_NAME and WM_CLASS (X11) or the xdg app id (Wayland): docks and taskbars match the window
        // to the .desktop entry by this id (its StartupWMClass).
        titlebar: Some(TitlebarOptions { title: Some("AIO Proxy".into()), ..TitleBar::title_bar_options() }),
        app_id: Some("aio-proxy-desktop".into()),
        ..TitleBar::window_options()
    })
}

pub fn after_open(_handle: AnyWindowHandle, _cx: &mut App) {}

/// A normal window stays open when another one takes focus.
pub fn closes_on_deactivate() -> bool {
    false
}
