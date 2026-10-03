//! Windows. Connection ownership comes from the TCP table and the owning process's account SID.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::{App, QuitMode};

use crate::app::AppEvent;
use crate::install::Paths;

/// `%LOCALAPPDATA%\aio-proxy-desktop`; without it, the same place under the profile.
pub fn paths(home: &Path) -> Paths {
    paths_from(home, |name| std::env::var_os(name))
}

/// `paths` with the environment passed in, so tests never resolve to the real data directory.
pub fn paths_from(home: &Path, env: impl Fn(&str) -> Option<OsString>) -> Paths {
    let local = env("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| home.join("AppData").join("Local"));
    let support = local.join("aio-proxy-desktop");
    // The lock is runtime state and is taken before `copy::prepare` runs, so it must not sit in the install
    // directory that check may find read-only: the per-user temp directory, as Windows resolves it.
    let temp = env("TEMP").map(PathBuf::from).filter(|dir| dir.is_absolute()).unwrap_or_else(|| local.join("Temp"));
    Paths {
        home: home.to_path_buf(),
        stable: support.join("bin").join("aio-proxy.exe"),
        lock: temp.join("aio-proxy-desktop.lock"),
        logs: support.join("logs"),
        support,
    }
}

/// A black mark on a light taskbar, white otherwise (dark, or the value missing).
pub fn tray_color(_cx: &App) -> [u8; 3] {
    let light = windows_registry::CURRENT_USER
        .open(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|key| key.get_u32("SystemUsesLightTheme"))
        .is_ok_and(|value| value == 1);
    if light { [0, 0, 0] } else { [255, 255, 255] }
}

/// gpui quits when the last window closes outside macOS; closing the panel must leave the tray
/// icon running.
pub fn on_launch(cx: &mut App, _events: UnboundedSender<AppEvent>) {
    cx.set_quit_mode(QuitMode::Explicit);
}

/// The account's SID string (`S-1-5-21-…`); empty when it cannot be read.
pub fn current_user() -> String {
    process::sid_string(&process::current_user_sid())
}

/// Restart an external service through the CLI: `service stop`, then `service start`. A bare
/// `schtasks /End` ends only the task's `conhost`, leaving the supervisor running for `/Run` to
/// start a second one; `service stop` ends the supervisor too. `service restart` would rewrite the
/// task to this app's binary, but `start` keeps the existing task and spec.
pub fn kickstart(_sid: &str, cli: impl Fn(&[&str]) -> Command) -> Vec<(Command, bool)> {
    vec![(cli(&["service", "stop"]), false), (cli(&["service", "start"]), false)]
}

pub use peer::peer_owned_by_this_user;
pub use process::pid_alive;

pub mod login_item;
mod peer;
mod process;
pub mod user_path;

pub use super::updater_packager as updater;

pub mod panel;

#[cfg(test)]
mod tests;
