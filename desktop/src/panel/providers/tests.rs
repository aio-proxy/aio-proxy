// Not `super::*`: that glob carries gpui's own `test` attribute, which shadows the built-in one.
use super::{quota_status, quota_text};
use crate::panel::format::parse_utc;
use crate::summary::{LocalizedText, Quota, QuotaWindow};

fn window(remaining_ratio: Option<f64>, resets_at: Option<&str>) -> QuotaWindow {
    QuotaWindow {
        id: "primary".into(),
        label: LocalizedText::Plain("5 hours".into()),
        remaining_ratio,
        resets_at: resets_at.map(str::to_string),
        window_minutes: Some(300),
    }
}

#[test]
fn describes_a_quota_window() {
    let now = parse_utc("2026-09-29T08:00:00.000Z").unwrap();
    assert_eq!(
        quota_text(&window(Some(0.4), Some("2026-09-29T10:00:00.000Z")), now),
        "5 hours · 40% left · resets in 2h 0m"
    );
    assert_eq!(quota_text(&window(None, None), now), "5 hours · no data");
}

#[test]
fn loading_and_failed_quota_are_worded_differently() {
    assert_eq!(quota_status(&Quota::Loading), Some("Quota loading…"));
    assert_eq!(quota_status(&Quota::Failed), Some("Quota unavailable"));
    assert_eq!(quota_status(&Quota::Unsupported), None);
}
