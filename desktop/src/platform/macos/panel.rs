//! The menu-bar PopUp: anchored under the status item, frosted, animation off, closed by click-away.

use gpui_kit::*;
use objc2::rc::Retained;
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAutoresizingMaskOptions, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
    NSVisualEffectView, NSWindow, NSWindowAnimationBehavior, NSWindowOrderingMode,
};
use objc2_foundation::{NSNumber, NSString};
use tray_icon::TrayIcon;

use crate::log;
use crate::panel::placement::{Frame, panel_origin};
use crate::panel::{PANEL_HEIGHT, PANEL_WIDTH};
use crate::tray::Tray;

/// The status item's frame is zero until AppKit lays out the menu bar, so anchor only from a click.
pub fn window_options(_cx: &App, tray: &Tray) -> Option<WindowOptions> {
    let Some((x, y, display)) = anchor(&tray.icon) else {
        log::info("panel: could not compute the anchor");
        return None;
    };
    Some(WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds {
            origin: point(px(x as f32), px(y as f32)),
            size: size(px(PANEL_WIDTH as f32), px(PANEL_HEIGHT as f32)),
        })),
        titlebar: None,
        focus: true,
        // Shown by hand in `after_open`, after the animation is turned off.
        show: false,
        kind: WindowKind::PopUp,
        is_movable: false,
        is_resizable: false,
        is_minimizable: false,
        // See `frost`: the blur goes in by hand, under GPUI's content.
        window_background: WindowBackgroundAppearance::Transparent,
        display_id: Some(DisplayId::new(u64::from(display))),
        ..Default::default()
    })
}

pub fn after_open(window: &mut Window) {
    if let Some(native) = native_window(window) {
        // AppKit's utility-window animation otherwise runs on its own thread for every open and close.
        native.setAnimationBehavior(NSWindowAnimationBehavior::None);
        frost(&native);
        native.makeKeyAndOrderFront(None);
    }
}

/// Click-away closes the panel (passed by hand on 2026-09-30, spike check 2 item 1).
pub fn closes_on_deactivate() -> bool {
    true
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

/// Puts the system popover material under GPUI's content view. GPUI's own `Blurred` background
/// strips the effect view's layers to make the blur colorless, which on macOS 27 leaves no blur at
/// all; the panel tints the plain material with its own tokens instead.
fn frost(window: &NSWindow) {
    let (Some(mtm), Some(content)) = (MainThreadMarker::new(), window.contentView()) else { return };
    let effect = NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(mtm), content.bounds());
    effect.setMaterial(NSVisualEffectMaterial::Popover);
    effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    effect.setState(NSVisualEffectState::Active);
    effect.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content.addSubview_positioned_relativeTo(&effect, NSWindowOrderingMode::Below, None);
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
