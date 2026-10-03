//! Everything OS-specific. Each build compiles exactly one module below, and every one provides the
//! same items; shared code reaches the OS only through `platform::*`.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(windows, test))]
pub mod shell_path;
#[cfg(any(windows, test))]
mod startup_approved;
#[cfg(any(windows, test))]
mod tcp_row;
#[cfg(unix)]
mod unix;
#[cfg(any(target_os = "linux", windows))]
pub mod update_key;
#[cfg(any(target_os = "linux", windows, test))]
pub mod updater_packager;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(target_os = "macos")]
pub use macos::*;
#[cfg(windows)]
pub use windows::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginItemStatus {
    NotRegistered,
    Enabled,
    /// Registered, but the user must allow it: macOS Login Items, or Windows Startup apps after
    /// they disabled it there or in Task Manager.
    RequiresApproval,
    NotFound,
    Unavailable,
}
