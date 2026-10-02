//! Linux. No updater yet; connection ownership comes from `/proc/net/tcp`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::{App, QuitMode, WindowAppearance};

use crate::app::AppEvent;
use crate::install::Paths;

/// XDG base directories count only when absolute; the XDG spec says to ignore relative and empty ones.
pub fn paths(home: &Path) -> Paths {
    paths_from(home, |name| std::env::var_os(name))
}

/// `paths` with the environment passed in, so tests never resolve to the real data directory.
pub fn paths_from(home: &Path, env: impl Fn(&str) -> Option<OsString>) -> Paths {
    let base = |var: &str, default: &str| {
        env(var).map(PathBuf::from).filter(|dir| dir.is_absolute()).unwrap_or_else(|| home.join(default))
    };
    let support = base("XDG_DATA_HOME", ".local/share").join("aio-proxy-desktop");
    Paths {
        home: home.to_path_buf(),
        stable: support.join("bin/aio-proxy"),
        lock: support.join("instance.lock"),
        logs: base("XDG_STATE_HOME", ".local/state").join("aio-proxy-desktop"),
        support,
    }
}

pub fn tray_color(cx: &App) -> [u8; 3] {
    let dark = matches!(cx.window_appearance(), WindowAppearance::Dark | WindowAppearance::VibrantDark);
    tray_color_for(std::env::var("XDG_CURRENT_DESKTOP").ok().as_deref(), dark)
}

/// The icon has no background of its own. GNOME's top bar is dark in either theme and the
/// AppIndicator extension shows the pixels as they are, so white there; elsewhere panels follow the
/// theme: white on dark, black on light.
pub fn tray_color_for(desktop: Option<&str>, dark: bool) -> [u8; 3] {
    let gnome = desktop.is_some_and(|desktop| desktop.split(':').any(|name| name.eq_ignore_ascii_case("GNOME")));
    if gnome || dark { [255, 255, 255] } else { [0, 0, 0] }
}

/// Linux closes the last window without quitting: in tray mode the icon reopens it, and no-tray
/// mode quits by hand (`close_action`).
pub fn on_launch(cx: &mut App, events: UnboundedSender<AppEvent>) {
    cx.set_quit_mode(QuitMode::Explicit);
    tray_host::watch_tray_host(events);
}

pub fn kickstart(_user: &str) -> Vec<Command> {
    let mut command = Command::new("systemctl");
    command.args(["--user", "restart", "aio-proxy.service"]);
    vec![command]
}

pub use super::unix::{current_user, pid_alive};
pub use peer::peer_owned_by_this_user;

pub mod login_item;
mod peer;

pub mod updater {
    use futures::channel::mpsc::UnboundedSender;

    use crate::app::AppEvent;
    use crate::log;

    pub fn start(_events: UnboundedSender<AppEvent>) {
        log::info("updater: not available on this platform yet");
    }

    pub fn check_now() {}
}

pub mod panel;
mod tray_host;

#[cfg(test)]
mod tests;
