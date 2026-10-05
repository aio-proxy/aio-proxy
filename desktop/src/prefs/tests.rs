use std::fs;

use super::{LabelStyle, Prefs, TrayMetric, prefs_path};
use crate::app::AppModel;

#[test]
fn missing_and_corrupt_files_use_defaults() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("preferences.json");
    let expected = Prefs { tray_metrics: vec![], tray_show_icon: true, tray_label_style: LabelStyle::Unit };
    assert_eq!(Prefs::load(&path), expected);
    fs::write(&path, "{not json").unwrap();
    assert_eq!(Prefs::load(&path), expected);
}

#[test]
fn unknown_metrics_are_discarded_before_applying_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("preferences.json");
    fs::write(
        &path,
        r#"{"trayMetrics":["todayTokens","bogus","inFlight","todayCost"],"trayShowIcon":false,"trayLabelStyle":"prefix"}"#,
    )
    .unwrap();
    assert_eq!(
        Prefs::load(&path),
        Prefs {
            tray_metrics: vec![TrayMetric::TodayTokens, TrayMetric::InFlight],
            tray_show_icon: false,
            tray_label_style: LabelStyle::Prefix,
        }
    );
}

#[test]
fn save_replaces_preferences_and_startup_loads_them() {
    let dir = tempfile::tempdir().unwrap();
    let paths = crate::platform::paths_from(dir.path(), |_| None);
    fs::create_dir_all(&paths.support).unwrap();
    let path = prefs_path(&paths);
    assert_eq!(path, paths.support.join("preferences.json"));
    let mut prefs = Prefs {
        tray_metrics: vec![TrayMetric::TodayCost, TrayMetric::TokensPerSecond],
        tray_show_icon: false,
        tray_label_style: LabelStyle::Prefix,
    };
    prefs.save(&path).unwrap();
    assert_eq!(Prefs::load(&path), prefs);
    prefs.tray_label_style = LabelStyle::Unit;
    prefs.save(&path).unwrap();
    assert_eq!(Prefs::load(&path), prefs);
    assert!(!paths.support.join("preferences.json.tmp").exists());
    assert_eq!(AppModel::new(paths, None).prefs, prefs);
}

#[test]
fn toggle_respects_limit_and_preserves_selection_order() {
    let mut prefs = Prefs {
        tray_metrics: vec![TrayMetric::TodayTokens, TrayMetric::InFlight],
        tray_show_icon: true,
        tray_label_style: LabelStyle::Unit,
    };
    prefs.toggle_metric(TrayMetric::TodayCost);
    assert_eq!(prefs.tray_metrics, vec![TrayMetric::TodayTokens, TrayMetric::InFlight]);
    prefs.toggle_metric(TrayMetric::TodayTokens);
    assert_eq!(prefs.tray_metrics, vec![TrayMetric::InFlight]);
    prefs.toggle_metric(TrayMetric::TodayCost);
    assert_eq!(prefs.tray_metrics, vec![TrayMetric::InFlight, TrayMetric::TodayCost]);
}

#[test]
fn empty_metrics_keep_icon_visible() {
    let mut prefs = Prefs { tray_metrics: vec![], tray_show_icon: false, tray_label_style: LabelStyle::Unit };
    assert!(prefs.shows_icon());
    prefs.toggle_metric(TrayMetric::TodayTokens);
    assert!(!prefs.shows_icon());
    prefs.tray_show_icon = true;
    assert!(prefs.shows_icon());
}

#[test]
fn duplicate_metrics_keep_the_first_occurrence_before_applying_limit() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("preferences.json");
    fs::write(
        &path,
        r#"{"trayMetrics":["todayTokens","todayTokens","inFlight"],"trayShowIcon":true,"trayLabelStyle":"unit"}"#,
    )
    .unwrap();
    assert_eq!(Prefs::load(&path).tray_metrics, vec![TrayMetric::TodayTokens, TrayMetric::InFlight]);
}
