//! The 12-month heatmap's layout: Sunday-first weekly columns ending in today's week, five levels
//! scaled to the busiest day, and the column where each month starts.

use super::format::{civil_from_days, parse_date};
use std::collections::HashMap;

use crate::summary::{ActivityDay, ActivityModel};

pub const WEEKS: usize = 53;

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeatCell {
    pub day: i64,
    pub tokens: u128,
    pub level: u8,
}

pub struct HeatGrid {
    pub weeks: Vec<[Option<HeatCell>; 7]>,
    pub months: Vec<(usize, &'static str)>,
    pub active_days: usize,
    pub total_tokens: u128,
    /// Each day's model split, for the hover card.
    pub models: HashMap<i64, Vec<ActivityModel>>,
}

/// 0 = Sunday. Day 0 (1970-01-01) was a Thursday.
fn weekday(day: i64) -> usize {
    (day + 4).rem_euclid(7) as usize
}

pub fn weekday_name(day: i64) -> &'static str {
    WEEKDAYS[weekday(day)]
}

/// The hover card's date, as the Dashboard's `PPP` formats it in English: `October 1st, 2026`.
pub fn long_date(day: i64) -> String {
    let (year, month, date) = civil_from_days(day);
    let suffix = match (date % 10, date % 100) {
        (_, 11..=13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{} {date}{suffix}, {year}", LONG_MONTHS[(month - 1) as usize])
}

pub fn heat_grid(activity: &[ActivityDay], today: i64) -> HeatGrid {
    let first = today - weekday(today) as i64 - (WEEKS as i64 - 1) * 7;
    let mut tokens = vec![0_u128; WEEKS * 7];
    let mut models = HashMap::new();
    for entry in activity {
        let Some(date) = parse_date(&entry.date) else { continue };
        let index = date - first;
        if (0..=today - first).contains(&index) {
            tokens[index as usize] = entry.total_tokens;
            models.insert(date, entry.models.clone());
        }
    }
    let max = tokens.iter().copied().max().unwrap_or(0);
    let level = |t: u128| if t == 0 || max == 0 { 0 } else { (1 + t * 3 / max).min(4) as u8 };
    let mut weeks = Vec::with_capacity(WEEKS);
    let mut months = Vec::new();
    for week in 0..WEEKS {
        let mut column = [None; 7];
        for (slot, cell) in column.iter_mut().enumerate() {
            let day = first + (week * 7 + slot) as i64;
            if day <= today {
                let t = tokens[week * 7 + slot];
                *cell = Some(HeatCell { day, tokens: t, level: level(t) });
            }
        }
        // A month labels the column holding its 1st, so a partial first month gets no label and a
        // month that starts mid-week (Oct 1 on a Thursday) still labels that week.
        let start = first + (week * 7) as i64;
        // A 1st that is still ahead of today would label cells that all belong to the old month.
        let first_of_month = (start..start + 7).find(|&d| d <= today && civil_from_days(d).2 == 1);
        if let Some(day) = first_of_month {
            months.push((week, MONTHS[(civil_from_days(day).1 - 1) as usize]));
        }
        weeks.push(column);
    }
    HeatGrid {
        weeks,
        months,
        active_days: tokens.iter().filter(|&&t| t > 0).count(),
        total_tokens: tokens.iter().sum(),
        models,
    }
}

#[cfg(test)]
mod tests;
