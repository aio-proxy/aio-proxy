//! aio-proxy menu-bar companion. `main.rs` is the GPUI/AppKit entry point; the pure logic in these
//! modules is unit-tested without either.

pub mod app;
pub mod client;
pub mod connect;
pub mod http;
pub mod install;
pub mod log;
pub mod login_item;
pub mod panel;
pub mod process;
pub mod summary;
pub mod token;
pub mod tray;
pub mod updater;
pub mod version;
