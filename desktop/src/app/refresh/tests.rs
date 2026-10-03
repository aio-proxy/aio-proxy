use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::{AppModel, DegradedReason, FetchOrder, SummaryState, rediscovers_after, summary_path, summary_request};
use crate::client::refresh::Tag;
use crate::client::transport::HttpError;
use crate::connect::discovery::fixture::discovery;
use crate::summary::UsageRange;

#[test]
fn no_desktop_token_means_the_degraded_panel_without_a_request_or_attention() {
    let mut model = AppModel::new(crate::platform::paths_from(Path::new("/Users/me"), |_| None), None);
    model.discovery = Some(discovery(|v| v["token"] = Value::Null));
    let Err(state) = summary_request(&model, order()) else { panic!("a request was built without a token") };
    assert!(matches!(state, SummaryState::Degraded(DegradedReason::NoToken)));
    model.summary = state;
    assert!(!model.needs_attention());
}

fn order() -> FetchOrder {
    FetchOrder { tag: Tag { session: 1, instance: 0, counter: 1 }, refresh_quota: false, range: UsageRange::H24 }
}

#[test]
fn the_summary_path_carries_the_range_and_the_refresh_flag() {
    assert_eq!(summary_path(UsageRange::H24, false), "/dashboard/api/desktop-summary?range=24h");
    assert_eq!(summary_path(UsageRange::D30, true), "/dashboard/api/desktop-summary?range=30d&refresh=true");
}

#[test]
fn a_vanished_instance_rediscovers_at_most_once_per_gap() {
    let now = Instant::now();
    let refused = HttpError::Connect(io::Error::from(io::ErrorKind::ConnectionRefused));
    assert!(rediscovers_after(&refused, None, now));
    assert!(rediscovers_after(&HttpError::UntrustedListener, None, now));
    assert!(!rediscovers_after(&refused, Some(now), now + Duration::from_secs(1)));
    assert!(rediscovers_after(&refused, Some(now), now + Duration::from_secs(5)));
    // A slow or garbled answer came from a live instance: discovery would find the same one.
    assert!(!rediscovers_after(&HttpError::Timeout, None, now));
    assert!(!rediscovers_after(&HttpError::Malformed("status line"), None, now));
}
