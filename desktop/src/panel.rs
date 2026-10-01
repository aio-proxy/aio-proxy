//! The anchored panel: placement, the PopUp window lifecycle, and its views.

mod activity;
mod degraded;
mod footer;
mod format;
mod groups;
mod header;
mod placement;
mod quota;
mod states;
mod status;

/// The menus disable Open Dashboard by the same rule that hides the footer's button.
pub(crate) use status::is_down;
mod usage;
mod view;
mod window;

pub use window::{PanelWindow, close_open, toggle};
