use std::time::{Duration, Instant};

use super::*;

const DONE: Finished = Finished::Summary { any_loading: false };
const LOADING: Finished = Finished::Summary { any_loading: true };

fn secs(n: u64) -> Duration {
    Duration::from_secs(n)
}

#[test]
fn opening_fetches_at_once_without_quota_refresh() {
    let mut s = Scheduler::default();
    let order = s.open(Instant::now()).expect("panel open fetches");
    assert!(!order.refresh_quota);
}

#[test]
fn a_response_from_a_closed_session_is_discarded() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let first = s.open(t0).unwrap();
    s.close();
    assert_eq!(s.finished(first.tag, DONE, t0), (false, None));
    let second = s.open(t0 + secs(1)).unwrap();
    assert!(!s.finished(first.tag, DONE, t0 + secs(1)).0);
    assert!(s.finished(second.tag, DONE, t0 + secs(1)).0);
}

#[test]
fn a_response_from_another_instance_is_discarded() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let old = s.open(t0).unwrap();
    let new = s.set_instance(7, t0).expect("a new instance refetches");
    assert_eq!(new.tag.instance, 7);
    assert!(!s.finished(old.tag, DONE, t0).0);
    assert!(s.finished(new.tag, DONE, t0).0);
}

#[test]
fn a_response_with_an_older_counter_is_discarded() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    let older = Tag { counter: order.tag.counter - 1, ..order.tag };
    assert!(!s.finished(older, DONE, t0).0);
    assert!(s.finished(order.tag, DONE, t0).0);
}

#[test]
fn the_15_second_floor_holds_under_a_trigger_storm() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    s.finished(order.tag, DONE, t0 + secs(1));
    for ms in (1_000..15_000).step_by(50) {
        let now = t0 + Duration::from_millis(ms);
        assert_eq!(s.trigger(Trigger::Tick, now), None, "fetched at {ms} ms");
        assert_eq!(s.wake(now), None, "woke into a fetch at {ms} ms");
    }
    assert_eq!(s.next_wake(), Some(t0 + secs(15)));
    assert!(s.wake(t0 + secs(15)).is_some());
}

#[test]
fn manual_refresh_bypasses_the_floor_and_refreshes_quota() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    s.finished(order.tag, DONE, t0);
    let manual = s.trigger(Trigger::Manual, t0 + secs(2)).expect("manual refresh fetches now");
    assert!(manual.refresh_quota);
    s.finished(manual.tag, DONE, t0 + secs(2));
    assert!(s.trigger(Trigger::ActionDone, t0 + secs(3)).is_some());
}

#[test]
fn a_trigger_during_a_request_runs_exactly_one_more_fetch() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    assert_eq!(s.trigger(Trigger::Manual, t0), None);
    assert_eq!(s.trigger(Trigger::ActionDone, t0), None);
    let (accepted, follow) = s.finished(order.tag, DONE, t0 + secs(1));
    assert!(accepted);
    let follow = follow.expect("the dirty trigger runs once the request finishes");
    assert!(follow.refresh_quota);
    assert_eq!(s.finished(follow.tag, DONE, t0 + secs(2)), (true, None));
}

#[test]
fn a_dirty_tick_still_waits_for_the_floor() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    assert_eq!(s.trigger(Trigger::Tick, t0), None);
    assert_eq!(s.finished(order.tag, DONE, t0 + secs(1)), (true, None));
    assert_eq!(s.next_wake(), Some(t0 + secs(15)));
}

#[test]
fn loading_quota_gets_one_shared_retry_after_two_seconds() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    s.finished(order.tag, LOADING, t0 + secs(1));
    assert_eq!(s.next_wake(), Some(t0 + secs(3)));
    assert_eq!(s.wake(t0 + Duration::from_millis(2_900)), None);
    let retry = s.wake(t0 + secs(3)).expect("one retry after 2 s");
    // Still loading: no second retry, just the next 15 s tick.
    assert_eq!(s.finished(retry.tag, LOADING, t0 + secs(4)), (true, None));
    assert_eq!(s.next_wake(), Some(t0 + secs(18)));
}

#[test]
fn closing_cancels_everything() {
    let t0 = Instant::now();
    let mut s = Scheduler::default();
    let order = s.open(t0).unwrap();
    s.finished(order.tag, LOADING, t0);
    s.close();
    assert!(!s.is_open());
    assert_eq!(s.next_wake(), None);
    assert_eq!(s.wake(t0 + secs(60)), None);
    assert_eq!(s.trigger(Trigger::Manual, t0 + secs(60)), None);
    assert_eq!(s.set_instance(9, t0 + secs(60)), None);
}
