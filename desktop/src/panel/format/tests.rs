use super::*;

#[test]
fn compacts_counts() {
    assert_eq!(compact(999), "999");
    assert_eq!(compact(1_204), "1.2K");
    assert_eq!(compact(14_815_402), "14.8M");
    assert_eq!(compact(148_000_000), "148M");
    assert_eq!(compact(1_500_000), "1.5M");
    assert_eq!(compact(18_014_398_509_481_985), "18014T");
}

#[test]
fn formats_nano_usd() {
    assert_eq!(usd(20_521_353_840), "$20.52");
    assert_eq!(usd(0), "$0.00");
    assert_eq!(usd(1), "<$0.01");
}

#[test]
fn round_trips_calendar_days() {
    assert_eq!(days_from_civil(1970, 1, 1), 0);
    assert_eq!(parse_date("2026-09-29"), Some(days_from_civil(2026, 9, 29)));
    assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
    assert_eq!(parse_date("2026-13-01"), None);
    assert_eq!(parse_date("yesterday"), None);
}

#[test]
fn parses_utc_timestamps_only() {
    assert_eq!(parse_utc("1970-01-02T00:00:01.000Z"), Some(86_401));
    assert_eq!(parse_utc("1970-01-01T00:00:00+00:00"), Some(0));
    assert_eq!(parse_utc("1970-01-01T08:00:00+08:00"), None);
}

#[test]
fn describes_reset_times() {
    assert_eq!(until(0, 30), "now");
    assert_eq!(until(0, 40 * 60), "in 40m");
    assert_eq!(until(0, 2 * 3_600 + 5 * 60), "in 2h 5m");
    assert_eq!(until(0, 3 * 86_400 + 3_600), "in 3d 1h");
    assert_eq!(until(100, 0), "now");
}

#[test]
fn labels_a_bucket_by_its_local_day() {
    // The golden fixture's bucket starts at local midnight in UTC+8.
    let start = parse_utc("2026-09-28T16:00:00.000Z").unwrap();
    assert_eq!(month_day(start, 8 * 3_600), "9/29");
    assert_eq!(month_day(start, 0), "9/28");
}
