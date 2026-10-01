use super::*;
use crate::panel::format::days_from_civil;
use crate::summary::ActivityDay;

fn day(y: i64, m: u32, d: u32) -> i64 {
    days_from_civil(y, m, d)
}

#[test]
fn the_grid_is_53_sunday_first_weeks_ending_in_the_week_of_today() {
    let today = day(2026, 10, 1); // a Thursday
    let grid = heat_grid(&[], today);
    assert_eq!(grid.weeks.len(), WEEKS);
    let last = &grid.weeks[WEEKS - 1];
    assert_eq!(last[4].map(|c| c.day), Some(today));
    assert!(last[5].is_none() && last[6].is_none(), "days after today are empty");
    let first_sunday = grid.weeks[0][0].map(|c| c.day).unwrap();
    assert_eq!((first_sunday + 4).rem_euclid(7), 0, "column starts on a Sunday");
}

#[test]
fn levels_scale_to_the_busiest_day_and_count_active_days() {
    let today = day(2026, 10, 1);
    let activity = [
        ActivityDay { date: "2026-10-01".into(), total_tokens: 400 },
        ActivityDay { date: "2026-09-30".into(), total_tokens: 100 },
        ActivityDay { date: "2025-01-01".into(), total_tokens: 999_999 }, // older than the grid
    ];
    let grid = heat_grid(&activity, today);
    let cell = |d| grid.weeks.iter().flatten().flatten().find(|c| c.day == d).copied().unwrap();
    assert_eq!(cell(today).level, 4);
    assert_eq!(cell(today - 1).level, 1);
    assert_eq!(cell(today - 2).level, 0);
    assert_eq!(grid.active_days, 2);
    assert_eq!(grid.total_tokens, 500);
}

#[test]
fn month_labels_mark_the_column_where_a_month_starts() {
    let grid = heat_grid(&[], day(2026, 10, 1));
    // Oct 1 is a Thursday, so it starts in the last column even though that column opens in Sep.
    assert_eq!(grid.months.last(), Some(&(WEEKS - 1, "Oct")));
    assert_eq!(grid.months.iter().rev().nth(1).map(|(_, m)| *m), Some("Sep"));
    let mut columns: Vec<_> = grid.months.iter().map(|(c, _)| *c).collect();
    columns.dedup();
    assert_eq!(columns.len(), grid.months.len(), "one label per column at most");
    assert_eq!(day_label(day(2026, 9, 29)), "Tue Sep 29");
}

#[test]
fn a_partial_first_month_gets_no_label() {
    // The first column opens on Sun 2025-09-28; Sep is partial there, so Oct (the 1st, col 0) is the first label.
    let grid = heat_grid(&[], day(2026, 10, 1));
    assert_eq!(grid.months.first(), Some(&(0, "Oct")));
    assert_eq!(grid.months.len(), 13);
}
