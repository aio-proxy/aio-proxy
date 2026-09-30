//! The PopUp window lifecycle: hybrid (destroy the window and its Metal surface on close, keep the
//! model), animation off, anchored from a click.

use std::time::{Duration, Instant};

use gpui_kit::*;
use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2_app_kit::{NSView, NSWindow, NSWindowAnimationBehavior};
use objc2_foundation::{NSNumber, NSString};
use tray_icon::TrayIcon;

use super::placement::{Frame, panel_origin};
use super::view::PanelView;
use crate::log;
use crate::tray::Tray;

pub const PANEL_WIDTH: f64 = 360.0;
pub const PANEL_HEIGHT: f64 = 560.0;
/// A click on the icon first deactivates the panel (closing it); that click must not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Default)]
pub struct PanelWindow {
    handle: Option<AnyWindowHandle>,
    /// Held only while the window exists; keeping it would keep the NSWindow alive.
    native: Option<Retained<NSWindow>>,
    closed_at: Option<Instant>,
}

impl Global for PanelWindow {}

pub fn toggle(cx: &mut App) {
    let (handle, closed_at) = {
        let state = cx.global::<PanelWindow>();
        (state.handle, state.closed_at)
    };
    if let Some(handle) = handle {
        let _ = handle.update(cx, |_, window, cx| close(window, cx));
        return;
    }
    if closed_at.is_some_and(|at| at.elapsed() < REOPEN_GUARD) {
        return;
    }
    // The status item's frame is zero until AppKit lays out the menu bar, so anchor only from a click.
    let Some((x, y, display)) = anchor(&cx.global::<Tray>().icon) else {
        log::info("panel: could not compute the anchor");
        return;
    };
    cx.activate(true);
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: point(px(x as f32), px(y as f32)),
            size: size(px(PANEL_WIDTH as f32), px(PANEL_HEIGHT as f32)),
        })),
        titlebar: None,
        focus: true,
        // Shown by hand below, after the animation is turned off.
        show: false,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        display_id: Some(DisplayId::new(u64::from(display))),
        ..Default::default()
    };
    match gpui_kit::open_window(options, cx, |window, cx| cx.new(|cx| PanelView::new(window, cx))) {
        Ok((handle, _view)) => {
            let native = handle.update(cx, |_, window, _| native_window(window)).ok().flatten();
            if let Some(native) = &native {
                // AppKit's utility-window animation otherwise runs on its own thread for every open and close.
                native.setAnimationBehavior(NSWindowAnimationBehavior::None);
                native.makeKeyAndOrderFront(None);
            }
            let state = cx.global_mut::<PanelWindow>();
            state.handle = Some(handle);
            state.native = native;
            crate::app::panel_opened(cx);
        }
        Err(error) => log::info(format!("panel: open_window failed: {error:#}")),
    }
}

/// Shared by the toggle and the deactivation observer.
pub fn close(window: &mut Window, cx: &mut App) {
    let state = cx.global_mut::<PanelWindow>();
    state.handle = None;
    state.native = None;
    state.closed_at = Some(Instant::now());
    window.remove_window();
    crate::app::panel_closed(cx);
}

/// Panel origin (display-local, top-down points) and the icon's display id.
fn anchor(tray: &TrayIcon) -> Option<(f64, f64, u32)> {
    let mtm = MainThreadMarker::new()?;
    let window = tray.ns_status_item()?.button(mtm)?.window()?;
    let screen = window.screen()?;
    let frame = |r: objc2_foundation::NSRect| Frame {
        x: r.origin.x,
        y: r.origin.y,
        width: r.size.width,
        height: r.size.height,
    };
    let display = screen
        .deviceDescription()
        .objectForKey(&NSString::from_str("NSScreenNumber"))
        .and_then(|n| n.downcast::<NSNumber>().ok())
        .map(|n| n.unsignedIntValue())?;
    let (x, y) = panel_origin(frame(window.frame()), frame(screen.frame()), PANEL_WIDTH);
    Some((x, y, display))
}

/// The NSWindow GPUI created, reached through the public raw-window-handle (an NSView).
fn native_window(window: &Window) -> Option<Retained<NSWindow>> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let RawWindowHandle::AppKit(handle) = HasWindowHandle::window_handle(window).ok()?.as_raw() else {
        return None;
    };
    // SAFETY: GPUI's AppKit handle wraps its live GPUIView for as long as `window` is borrowed.
    let view: &NSView = unsafe { handle.ns_view.cast().as_ref() };
    view.window()
}
