//! The panel window lifecycle: hybrid (destroy the window and its surface on close, keep the model).
//! Where and how the window opens is the platform's (`platform::panel`).

use std::time::{Duration, Instant};

use gpui_kit::*;

use super::view::PanelView;
use crate::log;
use crate::platform;
use crate::tray::Tray;

pub const PANEL_WIDTH: f64 = 360.0;
pub const PANEL_HEIGHT: f64 = 560.0;
/// A click on the icon first deactivates the panel (closing it); that click must not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct PanelWindow {
    handle: Option<AnyWindowHandle>,
    closed_at: Option<Instant>,
}

impl Global for PanelWindow {}

pub fn toggle(cx: &mut App) {
    let (handle, closed_at) = {
        let state = cx.global::<PanelWindow>();
        (state.handle, state.closed_at)
    };
    if let Some(handle) = handle {
        if handle.update(cx, |_, window, cx| close(window, cx)).is_ok() {
            return;
        }
        // The window is already gone: drop the stale handle and open a new one.
        cx.global_mut::<PanelWindow>().handle = None;
    }
    if closed_at.is_some_and(|at| at.elapsed() < REOPEN_GUARD) {
        return;
    }
    let Some(options) = platform::panel::window_options(cx, cx.global::<Tray>()) else {
        return;
    };
    cx.activate(true);
    let transparent = options.window_background == WindowBackgroundAppearance::Transparent;
    match gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| PanelView::new(window, cx))) {
        Ok((handle, _view)) => {
            let _ = handle.update(cx, |_, window, cx| {
                // GPUI Component's root plugin fills the window with the theme background, which would
                // cover a translucent one; the Root's own style is applied after it, so clear it there.
                if transparent && let Some(Some(root)) = window.root::<gpui_kit::base::Root>() {
                    root.update(cx, |root, _| root.style().background = Some(transparent_black().into()));
                }
                platform::panel::after_open(window);
            });
            cx.global_mut::<PanelWindow>().handle = Some(handle);
            crate::app::panel_opened(cx);
        }
        Err(error) => log::info(format!("panel: open_window failed: {error:#}")),
    }
}

/// Closes the panel if it is open; a no-op otherwise.
pub fn close_open(cx: &mut App) {
    let Some(handle) = cx.global::<PanelWindow>().handle else {
        return;
    };
    if handle.update(cx, |_, window, cx| close(window, cx)).is_err() {
        cx.global_mut::<PanelWindow>().handle = None;
    }
}

/// Shared by the toggle and the deactivation observer.
pub fn close(window: &mut Window, cx: &mut App) {
    let state = cx.global_mut::<PanelWindow>();
    state.handle = None;
    state.closed_at = Some(Instant::now());
    window.remove_window();
    crate::app::panel_closed(cx);
}
