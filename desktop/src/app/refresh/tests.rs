use std::path::Path;

use serde_json::Value;

use super::{AppModel, DegradedReason, SummaryState, summary_request};
use crate::connect::discovery::fixture::discovery;
use crate::install::Paths;

#[test]
fn no_desktop_token_means_the_degraded_panel_without_a_request_or_attention() {
    let mut model = AppModel::new(Paths::for_home(Path::new("/Users/me")), None);
    model.discovery = Some(discovery(|v| v["token"] = Value::Null));
    let Err(state) = summary_request(&model, false) else { panic!("a request was built without a token") };
    assert!(matches!(state, SummaryState::Degraded(DegradedReason::NoToken)));
    model.summary = state;
    assert!(!model.needs_attention());
}
