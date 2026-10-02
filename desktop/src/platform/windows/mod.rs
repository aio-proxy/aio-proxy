//! Windows. Stubs until later phase 3 tasks: no updater. Connection ownership
//! comes from the TCP table and the owning process's account SID.

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
    Paths {
        home: home.to_path_buf(),
        stable: support.join("bin").join("aio-proxy.exe"),
        lock: support.join("instance.lock"),
        logs: support.join("logs"),
        support,
    }
}

/// White until phase 3 reads the taskbar theme.
pub fn tray_color(_cx: &App) -> [u8; 3] {
    [255, 255, 255]
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

/// Restart the CLI's scheduled task: `/End` then `/Run`. `/End` exits non-zero when nothing is
/// running, which is exactly when a restart is needed, so only `/Run` must succeed.
pub fn kickstart(sid: &str) -> Vec<(Command, bool)> {
    use std::os::windows::process::CommandExt;
    let task = super::task_path::task_path(sid);
    [("/End", true), ("/Run", false)]
        .map(|(verb, allow_failure)| {
            let mut command = Command::new("schtasks");
            command.args([verb, "/TN", &task]).creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            (command, allow_failure)
        })
        .into()
}

pub use peer::peer_owned_by_this_user;
pub use process::pid_alive;

pub mod login_item;
mod peer;
mod process;

pub mod updater {
    use futures::channel::mpsc::UnboundedSender;

    use crate::app::AppEvent;
    use crate::log;

    pub fn start(_events: UnboundedSender<AppEvent>) {
        log::info("updater: not available on this platform yet");
    }

    pub fn check_now() {}
}

pub mod panel {
    use gpui_kit::*;

    use crate::panel::{PANEL_HEIGHT, PANEL_WIDTH};
    use crate::tray::Tray;

    pub fn window_options(cx: &App, _tray: Option<&Tray>) -> Option<WindowOptions> {
        let size = size(px(PANEL_WIDTH as f32), px(PANEL_HEIGHT as f32));
        Some(WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size, cx))),
            kind: WindowKind::Normal,
            ..Default::default()
        })
    }

    pub fn after_open(_handle: AnyWindowHandle, _cx: &mut App) {}

    pub fn closes_on_deactivate() -> bool {
        false
    }
}
