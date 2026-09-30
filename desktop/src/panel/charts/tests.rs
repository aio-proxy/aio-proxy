// Not `super::*`: that glob carries gpui's own `test` attribute, which shadows the built-in one.
use super::{HEATMAP_DAYS, heatmap_levels, trend_points};
use crate::panel::format::days_from_civil;
use crate::summary::{ActivityDay, TrendBucket};

fn day(date: &str, total_tokens: u128) -> ActivityDay {
    ActivityDay { date: date.into(), total_tokens }
}

#[test]
fn today_is_the_last_cell_and_the_busiest_day_is_level_four() {
    let today = days_from_civil(2026, 9, 29);
    let levels = heatmap_levels(&[day("2026-09-29", 100), day("2026-09-28", 10), day("2026-09-01", 0)], today);
    assert_eq!(levels.len(), HEATMAP_DAYS);
    assert_eq!(levels[HEATMAP_DAYS - 1], 4);
    assert_eq!(levels[HEATMAP_DAYS - 2], 1);
    assert_eq!(levels[HEATMAP_DAYS - 3], 0);
}

#[test]
fn days_outside_the_window_and_bad_dates_are_ignored() {
    let today = days_from_civil(2026, 9, 29);
    let levels = heatmap_levels(&[day("2025-09-29", 50), day("2026-09-30", 50), day("soon", 50)], today);
    assert!(levels.iter().all(|&l| l == 0));
}

#[test]
fn trend_points_are_labelled_by_local_day() {
    let bucket = TrendBucket {
        start: "2026-09-28T16:00:00.000Z".into(),
        requests: 257,
        total_tokens: 1,
        estimated_cost_nano_usd: 1,
    };
    let points = trend_points(&[bucket], 8 * 3_600);
    assert_eq!(points[0].label.as_ref(), "9/29");
    assert_eq!(points[0].requests, 257.0);
}
