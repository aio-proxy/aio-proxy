use super::*;
use crate::live::DesktopLive;
use crate::prefs::{LabelStyle, TrayMetric};
use std::time::{Duration, Instant};

fn live() -> DesktopLive {
    DesktopLive {
        today_tokens: 1_234_567,
        today_cost_nano_usd: 3_410_000_000,
        in_flight: 2,
        output_tokens_per_second: 48.25,
    }
}

fn text(metric: TrayMetric, live: &DesktopLive, prefix: &'static str, value: &str, unit: &'static str) {
    assert_eq!(
        format_metric(metric, live, LabelStyle::Prefix),
        MetricText { label: prefix, value: value.into(), unit: "" }
    );
    let unit_value = if metric == TrayMetric::TodayCost { format!("${value}") } else { value.into() };
    assert_eq!(format_metric(metric, live, LabelStyle::Unit), MetricText { label: "", value: unit_value, unit });
}

#[test]
fn formats_tokens_in_both_styles() {
    for (tokens, value) in [
        (999, "999"),
        (1_234, "1.23K"),
        (1_234_567, "1.23M"),
        (12_345_678, "12.3M"),
        (123_456_789, "123M"),
        (1_234_567_890, "1.23B"),
    ] {
        let mut live = live();
        live.today_tokens = tokens;
        text(TrayMetric::TodayTokens, &live, "TOK", value, "tok");
    }
}

#[test]
fn formats_rate_cost_and_requests_in_both_styles() {
    let mut live = live();
    for (rate, value) in [(48.25, "48.3"), (0.0, "0.0"), (123.6, "124")] {
        live.output_tokens_per_second = rate;
        text(TrayMetric::TokensPerSecond, &live, "TPS", value, "tok/s");
    }
    for (cost, value) in [(3_410_000_000, "3.41"), (123_400_000_000, "123")] {
        live.today_cost_nano_usd = cost;
        text(TrayMetric::TodayCost, &live, "USD", value, "");
    }
    text(TrayMetric::InFlight, &live, "REQ", "2", "req");
}

#[test]
fn token_rounding_promotes_precision_and_units_in_both_styles() {
    for (tokens, value) in [
        (9_994, "9.99K"),
        (9_995, "10.0K"),
        (99_949, "99.9K"),
        (99_950, "100K"),
        (999_499, "999K"),
        (999_950, "1.00M"),
        (999_999, "1.00M"),
        (999_499_999, "999M"),
        (999_950_000, "1.00B"),
    ] {
        let mut live = live();
        live.today_tokens = tokens;
        text(TrayMetric::TodayTokens, &live, "TOK", value, "tok");
    }
}

#[test]
fn rate_rounding_promotes_to_integer_precision_in_both_styles() {
    for (rate, value) in [(99.94, "99.9"), (99.95, "100")] {
        let mut live = live();
        live.output_tokens_per_second = rate;
        text(TrayMetric::TokensPerSecond, &live, "TPS", value, "tok/s");
    }
}

#[test]
fn cost_rounding_promotes_to_integer_precision_in_both_styles() {
    for (nano, value) in [(99_994_999_999, "99.99"), (99_995_000_000, "100")] {
        let mut live = live();
        live.today_cost_nano_usd = nano;
        text(TrayMetric::TodayCost, &live, "USD", value, "");
    }
}

#[test]
fn chooses_poll_interval_for_selected_metrics() {
    assert_eq!(poll_interval(&[]), None);
    assert_eq!(poll_interval(&[TrayMetric::TodayTokens]), Some(Duration::from_secs(15)));
    assert_eq!(poll_interval(&[TrayMetric::TodayCost]), Some(Duration::from_secs(15)));
    assert_eq!(poll_interval(&[TrayMetric::TodayCost, TrayMetric::InFlight]), Some(Duration::from_secs(1)));
    assert_eq!(poll_interval(&[TrayMetric::TokensPerSecond]), Some(Duration::from_secs(1)));
}

#[test]
fn schedule_prevents_overlap_and_observes_one_second_interval() {
    let now = Instant::now();
    let key = LiveKey { metrics: vec![TrayMetric::InFlight], epoch: 1 };
    let mut schedule = LiveSchedule::default();
    assert!(schedule.due(now, &key, true));
    assert!(!schedule.due(now + Duration::from_secs(1), &key, true));
    schedule.finished();
    assert!(!schedule.due(now + Duration::from_millis(500), &key, true));
    assert!(schedule.due(now + Duration::from_secs(1), &key, true));
}

#[test]
fn schedule_observes_fifteen_seconds_and_key_changes() {
    let now = Instant::now();
    let mut key = LiveKey { metrics: vec![TrayMetric::TodayTokens], epoch: 1 };
    let mut schedule = LiveSchedule::default();
    assert!(schedule.due(now, &key, true));
    schedule.finished();
    assert!(!schedule.due(now + Duration::from_secs(14), &key, true));
    assert!(schedule.due(now + Duration::from_secs(15), &key, true));
    schedule.finished();
    key.metrics = vec![TrayMetric::TodayCost];
    assert!(schedule.due(now + Duration::from_secs(16), &key, true));
    schedule.finished();
    key.epoch = 2;
    assert!(schedule.due(now + Duration::from_secs(17), &key, true));
}

#[test]
fn schedule_recovers_immediately_but_never_polls_empty_metrics() {
    let now = Instant::now();
    let mut key = LiveKey { metrics: vec![TrayMetric::TodayTokens], epoch: 1 };
    let mut schedule = LiveSchedule::default();
    assert!(schedule.due(now, &key, true));
    assert!(!schedule.due(now + Duration::from_secs(1), &key, false));
    assert!(!schedule.due(now + Duration::from_secs(2), &key, true));
    schedule.finished();
    assert!(schedule.due(now + Duration::from_secs(2), &key, true));
    schedule.finished();
    key.metrics.clear();
    for seconds in [3, 20, 100] {
        assert!(!schedule.due(now + Duration::from_secs(seconds), &key, true));
    }
}

#[test]
fn display_transitions_from_fresh_to_stale_to_unavailable_and_recovers() {
    let mut display = LiveDisplay::default();
    assert!(matches!(display.view(), LiveView::Unavailable));
    display.accept(0, live());
    assert!(matches!(display.view(), LiveView::Fresh(data) if data.today_tokens == 1_234_567));
    for _ in 0..2 {
        display.fail(0);
        assert!(matches!(display.view(), LiveView::Stale(data) if data.today_tokens == 1_234_567));
    }
    display.fail(0);
    assert!(matches!(display.view(), LiveView::Unavailable));
    display.accept(0, live());
    assert!(matches!(display.view(), LiveView::Fresh(_)));
}

#[test]
fn unauthorized_counts_failures_and_allows_one_retry_until_success() {
    let mut display = LiveDisplay::default();
    display.accept(0, live());
    assert!(display.unauthorized(0));
    assert!(matches!(display.view(), LiveView::Stale(_)));
    assert!(!display.unauthorized(0));
    display.fail(0);
    assert!(matches!(display.view(), LiveView::Unavailable));
    display.accept(0, live());
    assert!(display.unauthorized(0));
}

#[test]
fn epoch_change_discards_data_and_ignores_all_old_responses() {
    let mut display = LiveDisplay::default();
    display.set_epoch(1);
    display.accept(1, live());
    display.set_epoch(2);
    assert_eq!(display.epoch(), 2);
    display.accept(1, live());
    assert!(matches!(display.view(), LiveView::Unavailable));
    display.fail(1);
    assert!(!display.unauthorized(1));
    display.accept(2, live());
    display.fail(1);
    assert!(!display.unauthorized(1));
    assert!(matches!(display.view(), LiveView::Fresh(_)));
    assert!(display.unauthorized(2));
}

#[test]
fn epoch_change_resets_failure_count_and_auth_retry_but_same_epoch_preserves_state() {
    let mut display = LiveDisplay::default();
    display.accept(0, live());
    assert!(display.unauthorized(0));
    display.set_epoch(0);
    assert!(matches!(display.view(), LiveView::Stale(_)));
    assert!(!display.unauthorized(0));
    display.fail(0);
    display.set_epoch(1);
    // No cached data makes view() unavailable regardless of the failure count.
    assert_eq!(display.failures, 0);
    assert!(matches!(display.view(), LiveView::Unavailable));
    assert!(display.unauthorized(1));
    display.accept(1, live());
    display.fail(1);
    assert!(matches!(display.view(), LiveView::Stale(_)));
}

#[test]
fn rediscovery_requires_unreachable_discovery_and_is_throttled_for_five_seconds() {
    let now = Instant::now();
    assert!(rediscover_unreachable(true, true, Some(false), None, now));
    assert!(!rediscover_unreachable(true, true, Some(false), Some(now), now + Duration::from_secs(4)));
    assert!(rediscover_unreachable(true, true, Some(false), Some(now), now + Duration::from_secs(5)));
    for reachable in [Some(true), None] {
        assert!(!rediscover_unreachable(true, true, reachable, None, now));
    }
    assert!(!rediscover_unreachable(true, false, Some(false), None, now));
    assert!(!rediscover_unreachable(false, true, Some(false), None, now));
}
