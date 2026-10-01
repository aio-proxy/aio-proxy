//! The anchored panel: placement, the PopUp window lifecycle, and its views.

mod actions;
mod charts;
mod degraded;
mod footer;
mod format;
mod placement;
mod providers;
mod status;
mod usage;
mod view;
mod window;

pub use window::{PanelWindow, close_open, toggle};
