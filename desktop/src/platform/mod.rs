//! Everything OS-specific. Each build compiles exactly one module below, and every one provides the
//! same items; shared code reaches the OS only through `platform::*`.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod unix;
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
    /// Registered, but the user must allow it in System Settings > General > Login Items.
    RequiresApproval,
    NotFound,
    Unavailable,
}
