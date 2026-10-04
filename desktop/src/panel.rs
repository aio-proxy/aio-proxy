//! The anchored panel: placement, the PopUp window lifecycle, and its views.

mod activity;
/// The Windows backdrop decision; pure, so its tests run on every platform.
pub mod backdrop;
mod degraded;
mod footer;
mod format;
mod groups;
mod header;
/// Anchoring beside the menu-bar or tray icon; pure, so its tests run on every platform.
pub mod placement;
mod quota;
mod states;
mod status;

/// The menus disable Open Dashboard by the same rule that hides the footer's button.
pub(crate) use status::is_down;
mod usage;
mod view;
mod window;

pub(crate) use window::{PANEL_HEIGHT, PANEL_WIDTH};
pub use window::{PanelWindow, close_open, show, toggle, tray_host_changed};
