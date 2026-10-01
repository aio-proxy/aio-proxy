use super::*;

fn totals(requests: u128, failed: u128, cost: u128, coverage: Option<f64>) -> UsageTotals {
    UsageTotals {
        requests,
        failed_requests: failed,
        input_tokens: 60,
        output_tokens: 40,
        estimated_cost_nano_usd: cost,
        pricing_coverage: coverage,
    }
}

#[test]
fn deltas_color_failed_and_cost_but_not_traffic() {
    assert_eq!(delta(112, 100, Metric::Requests), ("↑ 12%".to_string(), Tone::Neutral));
    assert_eq!(delta(90, 100, Metric::Tokens), ("↓ 10%".to_string(), Tone::Neutral));
    assert_eq!(delta(8, 5, Metric::Failed), ("+3".to_string(), Tone::Bad));
    assert_eq!(delta(3, 5, Metric::Failed), ("−2".to_string(), Tone::Good));
    assert_eq!(delta(105, 100, Metric::Cost), ("↑ 5%".to_string(), Tone::Bad));
    assert_eq!(delta(95, 100, Metric::Cost), ("↓ 5%".to_string(), Tone::Good));
}

#[test]
fn a_zero_previous_window_reads_new_or_dash() {
    assert_eq!(delta(4, 0, Metric::Requests), ("new".to_string(), Tone::Neutral));
    assert_eq!(delta(0, 0, Metric::Cost), ("—".to_string(), Tone::Neutral));
}

#[test]
fn cost_marks_partial_pricing_and_unknown_pricing() {
    assert_eq!(card_value(&totals(1, 0, 4_120_000_000, Some(1.0)), Metric::Cost), "$4.12");
    assert_eq!(card_value(&totals(1, 0, 4_120_000_000, Some(0.8)), Metric::Cost), "≈$4.12");
    assert_eq!(card_value(&totals(1, 0, 0, None), Metric::Cost), "—");
    assert_eq!(card_value(&totals(1_240, 0, 0, None), Metric::Requests), "1.2K");
    assert_eq!(card_value(&totals(1, 0, 0, None), Metric::Tokens), "100");
}

#[test]
fn a_zero_percent_change_has_no_color() {
    assert_eq!(delta(1_004, 1_000, Metric::Cost), ("↑ 0%".to_string(), Tone::Neutral));
    assert_eq!(delta(996, 1_000, Metric::Cost), ("↓ 0%".to_string(), Tone::Neutral));
}

#[test]
fn unknown_pricing_leaves_the_cost_delta_blank() {
    let (now, before) = (totals(5, 0, 900, None), totals(5, 0, 300, Some(1.0)));
    assert_eq!(card_delta(&now, &before, Metric::Cost), ("—".to_string(), Tone::Neutral));
    let priced = totals(5, 0, 900, Some(1.0));
    assert_eq!(card_delta(&priced, &before, Metric::Cost), ("↑ 200%".to_string(), Tone::Bad));
    assert_eq!(card_delta(&now, &before, Metric::Requests).0, "↑ 0%");
}

#[test]
fn hourly_buckets_read_as_the_local_time_they_start() {
    // 2026-09-29T14:30:00Z, UTC+8 → 22:30.
    assert_eq!(bucket_label("2026-09-29T14:30:00.000Z", BucketUnit::Hour, UsageRange::H24, 8 * 3_600), "22:30");
    // 2026-09-29T02:15:00Z, UTC−5 → 21:15 the day before (crosses midnight).
    assert_eq!(bucket_label("2026-09-29T02:15:00.000Z", BucketUnit::Hour, UsageRange::H24, -5 * 3_600), "21:15");
}

#[test]
fn daily_buckets_use_weekdays_for_7d_and_month_day_for_30d() {
    let start = "2026-09-28T16:00:00.000Z"; // UTC+8 → Tue Sep 29
    let offset = 8 * 3_600;
    assert_eq!(bucket_label(start, BucketUnit::Day, UsageRange::D7, offset), "Tue");
    assert_eq!(bucket_label(start, BucketUnit::Day, UsageRange::D30, offset), "Sep 29");
    // UTC−5: 2026-09-29T05:00Z is local midnight of Tue Sep 29.
    assert_eq!(bucket_label("2026-09-29T05:00:00.000Z", BucketUnit::Day, UsageRange::D7, -5 * 3_600), "Tue");
    assert_eq!(bucket_label("not a date", BucketUnit::Day, UsageRange::D30, 0), "");
}

fn requests(n: u128) -> UsageSlice {
    UsageSlice { requests: n, ..UsageSlice::default() }
}

#[test]
fn the_trend_stacks_the_top_four_and_folds_the_rest_into_other() {
    let buckets: Vec<UsageBucket> =
        [30, 12].iter().map(|&n| UsageBucket { start: String::new(), slice: requests(n) }).collect();
    let cell = |bucket, key: &str, n| TrendCell { bucket, key: key.into(), slice: requests(n) };
    // Six series; `a` ties `b` and `e` ties `f`, broken by name. The cells leave 3 + 2 of the buckets
    // unsplit, as models beyond the server's top 20 would.
    let cells = vec![
        cell(0, "a", 10),
        cell(0, "b", 6),
        cell(1, "b", 4),
        cell(0, "c", 5),
        cell(0, "d", 4),
        cell(1, "d", 2),
        cell(0, "e", 1),
        cell(1, "f", 1),
        cell(1, "zero", 0),
    ];
    let series = stack(&buckets, &cells, |key| key.to_uppercase(), Metric::Requests);
    let shape: Vec<_> = series.iter().map(|s| (s.label.as_str(), s.other, s.values.clone())).collect();
    assert_eq!(
        shape,
        [
            ("A", false, vec![10, 0]),
            ("B", false, vec![6, 4]),
            ("D", false, vec![4, 2]),
            ("C", false, vec![5, 0]),
            ("Other", true, vec![5, 6]),
        ]
    );
    // Every bucket stacks to its total.
    for (i, bucket) in buckets.iter().enumerate() {
        assert_eq!(series.iter().map(|s| s.values[i]).sum::<u128>(), bucket.slice.requests);
    }
}

#[test]
fn a_fully_split_trend_has_no_other() {
    let buckets = vec![UsageBucket { start: String::new(), slice: requests(3) }];
    let cells = vec![TrendCell { bucket: 0, key: "a".into(), slice: requests(3) }];
    let series = stack(&buckets, &cells, str::to_string, Metric::Requests);
    assert_eq!(series.len(), 1);
    assert!(stack(&buckets, &cells, str::to_string, Metric::Failed).is_empty());
}

#[test]
fn each_bucket_is_labelled_with_the_offset_at_its_own_start() {
    // A fall-back in a UTC−4/−5 zone between the two buckets: each local midnight keeps its day.
    let bucket = |start: &str| UsageBucket { start: start.into(), slice: UsageSlice::default() };
    let buckets = [bucket("2026-10-31T04:00:00.000Z"), bucket("2026-11-02T05:00:00.000Z")];
    let switch = parse_utc("2026-11-01T06:00:00.000Z").unwrap();
    let offset_at = |unix: i64| if unix < switch { -4 * 3_600 } else { -5 * 3_600 };
    assert_eq!(bucket_labels(&buckets, BucketUnit::Day, UsageRange::D30, offset_at), ["Oct 31", "Nov 2"]);
    // The later offset for both would have put Oct 31's midnight on Oct 30.
    assert_eq!(bucket_label(&buckets[0].start, BucketUnit::Day, UsageRange::D30, -5 * 3_600), "Oct 30");
}
