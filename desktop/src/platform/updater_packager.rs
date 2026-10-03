//! The Linux and Windows updater (`cargo-packager-updater`) behind the macOS module's interface:
//! checks at launch and every 6 hours, never installs on its own. The decisions are pure and compiled
//! on every platform for tests; the updater itself only on Linux and Windows.

use std::cmp::Ordering;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckOutcome {
    Available(String),
    /// A manual check found nothing newer.
    UpToDate,
    /// A background check found nothing newer.
    Silent,
}

/// `offered` is the feed's version and target entry for this build; `None` when the feed has no
/// entry for it, which is "no update", never an error.
pub fn decide_check(current: &str, offered: Option<(&str, &str)>, interactive: bool) -> CheckOutcome {
    match offered {
        Some((version, _target)) if crate::version::compare(version, current) == Some(Ordering::Greater) => {
            CheckOutcome::Available(version.to_string())
        }
        _ if interactive => CheckOutcome::UpToDate,
        _ => CheckOutcome::Silent,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallAction {
    /// Replace the running AppImage and relaunch it.
    InPlace,
    OpenUrl(String),
}

/// An AppImage is replaced in place only when its directory is writable; otherwise (or when not
/// running from an AppImage) the user gets that version's Release page.
pub fn install_action(appimage: Option<&Path>, dir_writable: impl Fn(&Path) -> bool, version: &str) -> InstallAction {
    match appimage.and_then(Path::parent) {
        Some(dir) if dir_writable(dir) => InstallAction::InPlace,
        _ => InstallAction::OpenUrl(format!("https://github.com/aio-proxy/aio-proxy/releases/tag/v{version}")),
    }
}

#[cfg(any(target_os = "linux", windows))]
pub use imp::{check_now, install_now, start};

#[cfg(any(target_os = "linux", windows))]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use cargo_packager_updater::semver::Version;
    use cargo_packager_updater::url::Url;
    use cargo_packager_updater::{
        Config, Error, Update, Updater, UpdaterBuilder, WindowsConfig, WindowsUpdateInstallMode,
    };
    use futures::channel::mpsc::UnboundedSender;

    use super::{CheckOutcome, decide_check};
    use crate::app::AppEvent;
    use crate::log;
    use crate::platform::update_key::{PUBLIC_KEY_B64, updater_pubkey, verified_download};
    use crate::version::APP_VERSION;

    /// `AIO_PROXY_DESKTOP_FEED_URL` replaces it at compile time for rehearsal builds only.
    const FEED_URL: &str = match option_env!("AIO_PROXY_DESKTOP_FEED_URL") {
        Some(url) => url,
        None => "https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/latest.json",
    };
    const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

    static EVENTS: OnceLock<UnboundedSender<AppEvent>> = OnceLock::new();
    /// The update the last check offered; the panel's button installs this one.
    static PENDING: Mutex<Option<Update>> = Mutex::new(None);
    static INSTALLING: AtomicBool = AtomicBool::new(false);
    /// One check at a time, in call order: a slow earlier check must not restore or clear an offer after a later
    /// one decided. (std's Mutex is not FIFO, but a waiter only ever applies a result fetched after the holder's.)
    static CHECKING: Mutex<()> = Mutex::new(());

    fn send(event: AppEvent) {
        if let Some(events) = EVENTS.get() {
            let _ = events.unbounded_send(event);
        }
    }

    fn updater() -> Result<Updater, Error> {
        let config = Config {
            endpoints: vec![Url::parse(FEED_URL)?],
            pubkey: updater_pubkey(PUBLIC_KEY_B64),
            windows: Some(WindowsConfig {
                installer_args: None,
                install_mode: Some(WindowsUpdateInstallMode::Passive),
            }),
        };
        UpdaterBuilder::new(Version::parse(APP_VERSION)?, config).build()
    }

    pub fn start(events: UnboundedSender<AppEvent>) {
        let _ = EVENTS.set(events);
        std::thread::spawn(|| {
            loop {
                check(false);
                std::thread::sleep(CHECK_INTERVAL);
            }
        });
        log::info("updater: started");
    }

    /// "Check for Updates…": reports either the update or that the app is up to date.
    pub fn check_now() {
        std::thread::spawn(|| check(true));
    }

    /// Drops an offer the feed no longer makes, so the button cannot install it.
    fn withdraw_offer() -> Option<Update> {
        if PENDING.lock().unwrap_or_else(|e| e.into_inner()).take().is_some() {
            send(AppEvent::UpdateAttended);
        }
        None
    }

    fn check(interactive: bool) {
        let _serial = CHECKING.lock().unwrap_or_else(|e| e.into_inner());
        let update = match updater().and_then(|updater| updater.check()) {
            // Nothing newer: an offer from an earlier check was withdrawn (a feed rollback).
            Ok(None) => withdraw_offer(),
            Ok(update) => update,
            // Only raised for a newer version the feed has no `target` entry for: not offered to us either.
            Err(Error::TargetNotFound(target)) => {
                log::info(format!("updater: the feed has no `{target}` entry"));
                withdraw_offer()
            }
            // Offline is not the user's problem until they ask.
            Err(error) => {
                log::info(format!("updater: check failed: {error}"));
                if interactive {
                    send(AppEvent::UpdateFailed(format!("Could not check for updates: {error}")));
                }
                return;
            }
        };
        let target = cargo_packager_updater::target().unwrap_or_default();
        let offered = update.as_ref().map(|update| (update.version.as_str(), target.as_str()));
        match decide_check(APP_VERSION, offered, interactive) {
            CheckOutcome::Available(version) => {
                *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = update;
                send(AppEvent::UpdateAvailable(version));
            }
            CheckOutcome::UpToDate => send(AppEvent::UpToDate),
            CheckOutcome::Silent => {}
        }
    }

    /// The panel's update button: downloads, verifies and installs the pending update off the main
    /// thread. A second press while one runs does nothing.
    pub fn install_now() {
        if INSTALLING.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(|| {
            let _guard = InstallingGuard;
            let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner()).clone();
            let result = pending.ok_or_else(|| "no update is pending".to_string()).and_then(|update| install(&update));
            if let Err(error) = result {
                log::info(format!("updater: install failed: {error}"));
                send(AppEvent::UpdateFailed(format!("Update failed: {error}")));
            }
        });
    }

    /// Re-arms the button however the install thread ends, including a panic inside the library
    /// (Windows `expect("installer failed to start")`).
    struct InstallingGuard;

    impl Drop for InstallingGuard {
        fn drop(&mut self) {
            if std::thread::panicking() {
                send(AppEvent::UpdateFailed("Update failed: the installer did not start".into()));
            }
            INSTALLING.store(false, Ordering::SeqCst);
        }
    }

    fn download(update: &Update) -> Result<Vec<u8>, String> {
        send(AppEvent::UpdateProgress(format!("Downloading AIO Proxy {}…", update.version)));
        verified_download(update)
    }

    /// The library launches the NSIS installer (Passive) and exits this process; the installer
    /// relaunches the app.
    #[cfg(windows)]
    fn install(update: &Update) -> Result<(), String> {
        update.install(download(update)?).map_err(|e| e.to_string())
    }

    /// The library swaps `$APPIMAGE` for the new file; the main thread then execs it.
    #[cfg(target_os = "linux")]
    fn install(update: &Update) -> Result<(), String> {
        use std::path::PathBuf;

        use super::{InstallAction, install_action};

        let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
        match install_action(appimage.as_deref(), dir_writable, &update.version) {
            InstallAction::OpenUrl(url) => send(AppEvent::OpenUrl(url)),
            InstallAction::InPlace => {
                update.install(download(update)?).map_err(|e| e.to_string())?;
                // `InPlace` means `$APPIMAGE` is set.
                if let Some(appimage) = appimage {
                    send(AppEvent::RelaunchInto(appimage));
                }
            }
        }
        Ok(())
    }

    /// access(2) honors ownership, ACLs and read-only mounts, unlike the mode bits.
    #[cfg(target_os = "linux")]
    fn dir_writable(dir: &std::path::Path) -> bool {
        let Ok(c_path) = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes()) else {
            return false;
        };
        // SAFETY: `c_path` is a valid NUL-terminated string for the call's duration.
        unsafe { libc::access(c_path.as_ptr(), libc::W_OK) == 0 }
    }
}

#[cfg(test)]
mod tests;
