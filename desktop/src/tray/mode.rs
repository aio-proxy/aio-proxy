//! Whether a tray host is there to show the icon. Only Linux can lack one (GNOME without the
//! AppIndicator extension); there the panel window becomes the app.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TrayMode {
    #[default]
    Tray,
    /// Nothing shows the icon: the window stays open and closing it quits.
    NoTray,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    Hide,
    Quit,
}

/// The mode after the tray icon appeared (`icon_shown`) or went away, and whether to open the
/// window. An icon that appears later never closes a window the user sees.
pub fn next_mode(current: TrayMode, icon_shown: bool) -> (TrayMode, bool) {
    match (current, icon_shown) {
        (_, true) => (TrayMode::Tray, false),
        (TrayMode::Tray, false) => (TrayMode::NoTray, true),
        (TrayMode::NoTray, false) => (TrayMode::NoTray, false),
    }
}

/// Without a tray nothing could show a hidden window again, so closing it quits; the proxy keeps
/// running under its own service manager.
pub fn close_action(mode: TrayMode) -> CloseAction {
    match mode {
        TrayMode::Tray => CloseAction::Hide,
        TrayMode::NoTray => CloseAction::Quit,
    }
}

#[cfg(test)]
mod tests;
