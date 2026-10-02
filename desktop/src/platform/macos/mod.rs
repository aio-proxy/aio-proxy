//! macOS: SMAppService, Sparkle, launchd, `lsof`, and the menu-bar PopUp panel.

use std::ffi::OsString;
use std::path::Path;

use futures::channel::mpsc::UnboundedSender;
use gpui_kit::App;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};

use crate::app::AppEvent;
use crate::install::Paths;

mod host;
pub mod login_item;
pub mod panel;
mod peer;
pub mod updater;
mod wake;

pub use host::{current_user, kickstart, pid_alive};
pub use peer::peer_owned_by_this_user;

pub fn paths(home: &Path) -> Paths {
    paths_from(home, |name| std::env::var_os(name))
}

/// The environment does not move anything on macOS.
pub fn paths_from(home: &Path, _env: impl Fn(&str) -> Option<OsString>) -> Paths {
    let support = home.join("Library/Application Support/aio-proxy-desktop");
    Paths {
        home: home.to_path_buf(),
        stable: support.join("bin/aio-proxy"),
        lock: support.join("instance.lock"),
        logs: home.join("Library/Logs/aio-proxy-desktop"),
        support,
    }
}

pub fn on_launch(_cx: &mut App, events: UnboundedSender<AppEvent>) {
    // GPUI forces the Regular policy in applicationDidFinishLaunching; LSUIElement covers launch.
    let mtm = MainThreadMarker::new().expect("GPUI runs this callback on the main thread");
    NSApplication::sharedApplication(mtm).setActivationPolicy(NSApplicationActivationPolicy::Accessory);
    wake::observe_wake(events);
}
