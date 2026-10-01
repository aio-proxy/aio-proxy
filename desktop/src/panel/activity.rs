//! The 12-month heatmap's layout: Sunday-first weekly columns ending in today's week, five levels
//! scaled to the busiest day, and the column where each month starts.

// Removed by Task 9, which renders these.
#![allow(dead_code)]

use super::format::{civil_from_days, parse_date};
use crate::summary::ActivityDay;

pub const WEEKS: usize = 53;

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
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
}

/// 0 = Sunday. Day 0 (1970-01-01) was a Thursday.
fn weekday(day: i64) -> usize {
    (day + 4).rem_euclid(7) as usize
}

pub fn day_label(day: i64) -> String {
    let (_, month, date) = civil_from_days(day);
    format!("{} {} {date}", WEEKDAYS[weekday(day)], MONTHS[(month - 1) as usize])
}

pub fn heat_grid(activity: &[ActivityDay], today: i64) -> HeatGrid {
    let first = today - weekday(today) as i64 - (WEEKS as i64 - 1) * 7;
    let mut tokens = vec![0_u128; WEEKS * 7];
    for entry in activity {
        let Some(date) = parse_date(&entry.date) else { continue };
        let index = date - first;
        if (0..=today - first).contains(&index) {
            tokens[index as usize] = entry.total_tokens;
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
        if let Some(month) = (start..start + 7).map(civil_from_days).find(|d| d.2 == 1).map(|d| d.1) {
            months.push((week, MONTHS[(month - 1) as usize]));
        }
        weeks.push(column);
    }
    HeatGrid {
        weeks,
        months,
        active_days: tokens.iter().filter(|&&t| t > 0).count(),
        total_tokens: tokens.iter().sum(),
    }
}

#[cfg(test)]
mod tests;
