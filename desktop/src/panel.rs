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
mod usage;
mod view;
mod window;

pub use window::{PanelWindow, close_open, toggle};
