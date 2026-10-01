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
fn ranking_follows_the_metric_and_puts_zeros_last() {
    let slices = [
        UsageSlice { requests: 10, failed_requests: 0, total_tokens: 5, estimated_cost_nano_usd: 0 },
        UsageSlice { requests: 2, failed_requests: 2, total_tokens: 50, estimated_cost_nano_usd: 9 },
        UsageSlice { requests: 5, failed_requests: 0, total_tokens: 0, estimated_cost_nano_usd: 1 },
    ];
    let order = |metric| ranked(&slices, |s| s, metric, None).iter().map(|(s, _, _)| s.requests).collect::<Vec<_>>();
    assert_eq!(order(Metric::Requests), [10, 5, 2]);
    assert_eq!(order(Metric::Cost), [2, 5, 10]);
    assert_eq!(order(Metric::Failed), [2, 10, 5]);
    let top = ranked(&slices, |s| s, Metric::Tokens, Some(2));
    assert_eq!(top.len(), 2);
    assert!((top[0].2 - 50.0 / 55.0).abs() < 1e-9);
}

#[test]
fn an_all_zero_metric_has_no_share() {
    let slices = [UsageSlice::default(), UsageSlice::default()];
    assert!(ranked(&slices, |s| s, Metric::Failed, None).iter().all(|(_, v, share)| *v == 0 && *share == 0.0));
    assert_eq!(Metric::Failed.empty_text(), "No failures in this window");
}

#[test]
fn bucket_labels_by_unit() {
    // 2026-09-29T14:00:00Z, UTC+8 → 22:00, Tue Sep 29.
    assert_eq!(bucket_label("2026-09-29T14:00:00.000Z", BucketUnit::Hour, 8 * 3_600), "22:00");
    assert_eq!(bucket_label("2026-09-28T16:00:00.000Z", BucketUnit::Day, 8 * 3_600), "Sep 29");
    assert_eq!(bucket_label("not a date", BucketUnit::Day, 0), "");
}
