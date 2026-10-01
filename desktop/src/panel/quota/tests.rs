use super::*;
use crate::summary::{Diagnostic, LocalizedText, ProviderState, QuotaWindow};

const NOW: i64 = 1_790_000_000;

fn iso(unix: i64) -> String {
    let (y, m, d) = crate::panel::format::civil_from_days(unix.div_euclid(86_400));
    let s = unix.rem_euclid(86_400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", s / 3600, s / 60 % 60, s % 60)
}

fn window(remaining: Option<f64>, left_min: Option<i64>, length: Option<u32>) -> QuotaWindow {
    QuotaWindow {
        id: "w".into(),
        label: LocalizedText::Plain("Weekly".into()),
        remaining_ratio: remaining,
        resets_at: left_min.map(|m| iso(NOW + m * 60)),
        window_minutes: length,
    }
}

fn provider(name: &str, quota: Quota, diagnostic: Option<&str>) -> Provider {
    Provider {
        id: name.to_lowercase(),
        name: name.into(),
        enabled: true,
        account_label: None,
        state: ProviderState::Ok,
        diagnostic: diagnostic.map(|summary| Diagnostic {
            code: "X".into(),
            summary: summary.into(),
            suggested_command: None,
        }),
        quota,
    }
}

fn ready(windows: Vec<QuotaWindow>) -> Quota {
    Quota::Ready { sampled_at: iso(NOW - 240), refresh_failed: false, plan: None, windows }
}

#[test]
fn ahead_of_pace_reports_reserve() {
    // 5 h window, 133 min left, 70% left: an even burn would leave 44%.
    let p = pace(0.70, 133.0, 300.0);
    assert!((p.expected - 133.0 / 300.0).abs() < 1e-9);
    assert!(!p.behind);
    assert_eq!(p.note, "26% in reserve · lasts until reset");
}

#[test]
fn behind_and_running_out_reports_when() {
    // Weekly, 5820 min left of 10080, 41% left → 17% over pace, runs out in about 2d 1h.
    let p = pace(0.41, 5_820.0, 10_080.0);
    assert!(p.behind);
    assert_eq!(p.note, "17% over pace · runs out in 2d 1h");
}

#[test]
fn exactly_on_pace_reads_zero_reserve() {
    // Half the window left with half the quota left. With a constant burn, "behind pace" and
    // "runs out before reset" are the same condition (remaining < expected), so on-pace is the
    // only zero-reserve case.
    let p = pace(0.5, 720.0, 1_440.0);
    assert!(!p.behind);
    assert_eq!(p.note, "0% in reserve · lasts until reset");
}

#[test]
fn missing_fields_mean_no_projection() {
    let view = |w| {
        let providers = [provider("A", ready(vec![w]), None)];
        quota_blocks(&providers, NOW).remove(0).windows.remove(0)
    };
    for w in [window(Some(0.5), None, Some(300)), window(Some(0.5), Some(60), None), window(None, Some(60), Some(300))]
    {
        assert!(view(w).pace.is_none());
    }
    let exhausted = view(window(Some(0.0), Some(60), Some(300)));
    assert!(exhausted.low);
    assert!(exhausted.pace.as_ref().is_some_and(|p| p.behind || p.note.contains("reserve")));
}

#[test]
fn only_quota_capable_providers_are_listed_and_ordered_by_attention() {
    let providers = vec![
        provider("Zed", ready(vec![window(Some(0.9), Some(600), Some(1_440))]), None),
        provider("Over", ready(vec![window(Some(0.41), Some(5_820), Some(10_080))]), None),
        provider("Low", ready(vec![window(Some(0.06), Some(4_560), Some(43_200))]), None),
        provider("Broken", Quota::Failed, Some("Credentials expired")),
        provider("NoQuota", Quota::None, None),
        provider("Unsupported", Quota::Unsupported, None),
        provider("Loading", Quota::Loading, None),
    ];
    let blocks = quota_blocks(&providers, NOW);
    let names: Vec<_> = blocks.iter().map(|b| b.provider.name.as_str()).collect();
    assert_eq!(names, ["Broken", "Low", "Over", "Loading", "Zed"]);
    assert_eq!(attention_count(&blocks), 2);
    assert_eq!(blocks[0].message.as_deref(), Some("Credentials expired"));
    assert!(blocks[3].loading);
}

#[test]
fn durations_and_relative_times() {
    assert_eq!(duration_text(45.0), "45m");
    assert_eq!(duration_text(125.0), "2h 5m");
    assert_eq!(duration_text(2_965.0), "2d 1h");
    assert_eq!(relative(NOW, NOW - 20), "just now");
    assert_eq!(relative(NOW, NOW - 240), "4 min ago");
    assert_eq!(relative(NOW, NOW - 3 * 3_600), "3 h ago");
    assert_eq!(relative(NOW, NOW - 2 * 86_400), "2 d ago");
}
