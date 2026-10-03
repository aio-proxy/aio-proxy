//! The panel window lifecycle: hybrid (destroy the window and its surface on close, keep the model).
//! Where and how the window opens is the platform's (`platform::panel`).

use std::time::{Duration, Instant};

use gpui_kit::*;

use super::view::PanelView;
use crate::log;
use crate::platform;
use crate::tray::{CloseAction, Tray, TrayMode, close_action, next_mode};

pub const PANEL_WIDTH: f64 = 360.0;
pub const PANEL_HEIGHT: f64 = 560.0;
/// A click on the icon first deactivates the panel (closing it); that click must not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct PanelWindow {
    handle: Option<AnyWindowHandle>,
    closed_at: Option<Instant>,
    tray_mode: TrayMode,
}

impl Global for PanelWindow {}

/// Opens the panel, or focuses it when it is already open.
pub fn show(cx: &mut App) {
    if let Some(handle) = cx.global::<PanelWindow>().handle {
        if handle.update(cx, |_, window, _| window.activate_window()).is_ok() {
            return;
        }
        cx.global_mut::<PanelWindow>().handle = None;
    }
    open(cx);
}

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
    open(cx);
}

/// Opens a new window, past the reopen guard: callers decide whether a click should be dropped.
fn open(cx: &mut App) {
    let Some(options) = platform::panel::window_options(cx, cx.try_global::<Tray>()) else {
        return;
    };
    cx.activate(true);
    let transparent = options.window_background != WindowBackgroundAppearance::Opaque;
    match gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| PanelView::new(window, cx))) {
        Ok((handle, _view)) => {
            let _ = handle.update(cx, |_, window, cx| {
                // GPUI Component's root plugin fills the window with the theme background, which would
                // cover a translucent one; the Root's own style is applied after it, so clear it there.
                if transparent && let Some(Some(root)) = window.root::<gpui_kit::base::Root>() {
                    root.update(cx, |root, _| root.style().background = Some(transparent_black().into()));
                }
                // The window manager's close (its button, Alt+F4): forget the window, or quit.
                #[cfg(target_os = "linux")]
                window.on_window_should_close(cx, |_, cx| {
                    match close_action(cx.global::<PanelWindow>().tray_mode) {
                        CloseAction::Hide => forget(cx),
                        CloseAction::Quit => cx.quit(),
                    }
                    true
                });
            });
            // Outside the update: showing the window re-enters GPUI, which must not find it borrowed.
            platform::panel::after_open(handle, cx);
            cx.global_mut::<PanelWindow>().handle = Some(handle);
            crate::app::panel_opened(cx);
        }
        Err(error) => {
            log::info(format!("panel: open_window failed: {error:#}"));
            // Without a tray nothing would be on screen: say why and stop, rather than idle unseen.
            if close_action(cx.global::<PanelWindow>().tray_mode) == CloseAction::Quit {
                eprintln!(
                    "aio-proxy-desktop: cannot open the window ({error:#}); install a Vulkan driver (e.g. mesa-vulkan-drivers)"
                );
                std::process::exit(1);
            }
        }
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
    window.remove_window();
    forget(cx);
}

/// The title bar's close button: hide the window, or quit when no tray could show it again.
pub fn close_by_user(window: &mut Window, cx: &mut App) {
    match close_action(cx.global::<PanelWindow>().tray_mode) {
        CloseAction::Hide => close(window, cx),
        CloseAction::Quit => cx.quit(),
    }
}

/// The tray icon appeared or went away (Linux); losing it opens the window, since nothing else could.
pub fn tray_host_changed(cx: &mut App, icon_shown: bool) {
    let state = cx.global_mut::<PanelWindow>();
    let (mode, open) = next_mode(state.tray_mode, icon_shown);
    state.tray_mode = mode;
    if open {
        show(cx);
    }
}

/// Bookkeeping for a window that is closing.
fn forget(cx: &mut App) {
    let state = cx.global_mut::<PanelWindow>();
    state.handle = None;
    state.closed_at = Some(Instant::now());
    crate::app::panel_closed(cx);
}
