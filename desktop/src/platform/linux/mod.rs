//! Linux. Stubs until the later tasks: no updater, no connection is vouched for
//! (the token is never sent), and `pid_alive` is always false until Task 5, so restart
//! verification rests on the health check alone.

use std::ffi::OsString;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::App;

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

pub fn on_launch(_cx: &mut App, _events: UnboundedSender<AppEvent>) {}

pub fn current_user() -> String {
    // SAFETY: getuid never fails.
    unsafe { libc::getuid() }.to_string()
}

pub fn kickstart(_user: &str) -> Vec<Command> {
    let mut command = Command::new("systemctl");
    command.args(["--user", "restart", "aio-proxy.service"]);
    vec![command]
}

pub fn pid_alive(_pid: u32) -> bool {
    false
}

pub fn peer_owned_by_this_user(_stream: &TcpStream, _deadline: Instant) -> bool {
    false
}

pub mod login_item;

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

    pub fn window_options(cx: &App, _tray: &Tray) -> Option<WindowOptions> {
        let size = size(px(PANEL_WIDTH as f32), px(PANEL_HEIGHT as f32));
        Some(WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(None, size, cx))),
            kind: WindowKind::Normal,
            ..Default::default()
        })
    }

    pub fn after_open(_window: &mut Window) {}

    pub fn closes_on_deactivate() -> bool {
        false
    }
}
