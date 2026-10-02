//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod app;
pub mod cli_command;
pub mod client;
pub mod connect;
// NSURLSession; replaced by a shared client in the next task.
#[cfg(target_os = "macos")]
pub mod http;
pub mod install;
pub mod log;
pub mod panel;
pub mod platform;
pub mod process;
pub mod summary;
pub mod theme;
pub mod token;
pub mod tray;
pub mod version;
