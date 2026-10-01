use super::*;

#[test]
fn one_failure_is_not_down_two_are() {
    let mut h = HealthTracker::default();
    assert_eq!(h.record(true), Some(HealthState::Up));
    assert_eq!(h.record(false), None);
    assert_eq!(h.state(), HealthState::Up);
    assert_eq!(h.record(false), Some(HealthState::Down));
    assert_eq!(h.record(false), None, "a transition is reported once");
}

#[test]
fn a_success_resets_the_failure_count() {
    let mut h = HealthTracker::default();
    h.record(true);
    h.record(false);
    h.record(true);
    assert_eq!(h.record(false), None);
    assert_eq!(h.state(), HealthState::Up);
}

#[test]
fn only_the_aio_proxy_marker_counts_as_healthy() {
    let ok = parse_health(200, br#"{"status":"ok","uptime":1.5,"version":"0.37.0"}"#);
    assert_eq!(ok, Some(HealthReport { version: Some("0.37.0".into()) }));
    assert_eq!(parse_health(200, br#"{"status":"degraded"}"#), None);
    assert_eq!(parse_health(200, b"OK"), None);
    assert_eq!(parse_health(503, br#"{"status":"ok"}"#), None);
}

#[test]
fn a_completed_stop_is_down_at_once_and_a_later_success_brings_it_back() {
    let mut h = HealthTracker::default();
    h.record(true);
    h.mark_down();
    assert_eq!(h.state(), HealthState::Down);
    assert_eq!(h.record(false), None, "the next failed probe is no new transition");
    assert_eq!(h.record(true), Some(HealthState::Up));
}

#[test]
fn only_the_latest_probe_counts() {
    let mut h = HealthTracker::default();
    let first = h.begin();
    assert_eq!(h.finish(first, true), Some(HealthState::Up));
    // Two probes overlap; the newer one answers first and the older one's failures land late.
    let old = h.begin();
    let new = h.begin();
    assert_eq!(h.finish(new, true), None);
    assert_eq!(h.finish(old, false), None);
    assert_eq!(h.finish(old, false), None, "stale failures never count toward Down");
    assert_eq!(h.state(), HealthState::Up);
}

#[test]
fn a_probe_in_flight_before_a_stop_cannot_bring_the_proxy_back() {
    let mut h = HealthTracker::default();
    let up = h.begin();
    h.finish(up, true);
    let in_flight = h.begin();
    h.mark_down();
    assert_eq!(h.finish(in_flight, true), None);
    assert_eq!(h.state(), HealthState::Down);
}
