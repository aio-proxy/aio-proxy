use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use super::*;
use crate::connect::discovery::fixture::discovery;
use crate::install::Paths;

fn model(patch: impl FnOnce(&mut Value)) -> AppModel {
    let mut model = AppModel::new(Paths::for_home(Path::new("/Users/me")), None);
    model.install = Some(InstallState::Persistent);
    model.discovery = Some(discovery(patch));
    model
}

#[test]
fn a_newer_copy_notice_names_that_copy() {
    let mut m = model(|_| {});
    m.install = Some(InstallState::ReadOnly(ReadOnlyReason::NewerCopy {
        app: PathBuf::from("/Applications/AIO Proxy.app"),
        version: "0.38.0".into(),
    }));
    assert_eq!(
        notice(&m).as_deref(),
        Some("A newer copy (0.38.0) is installed at /Applications/AIO Proxy.app. This copy is read-only.")
    );
}

#[test]
fn a_failed_action_is_shown_before_anything_else() {
    let mut m = model(|v| v["unit"]["owner"] = json!("external"));
    m.action = ActionState::Failed("service start failed".into());
    assert_eq!(notice(&m).as_deref(), Some("service start failed"));
}

#[test]
fn the_endpoint_line_names_who_runs_the_service() {
    assert_eq!(endpoint_line(&model(|_| {})).as_deref(), Some("127.0.0.1:9317 · started by AIO Proxy"));
    assert_eq!(
        endpoint_line(&model(|v| v["unit"]["owner"] = json!("external"))).as_deref(),
        Some("127.0.0.1:9317 · managed by the aio-proxy CLI")
    );
    assert_eq!(
        endpoint_line(&model(|v| v["job"]["disabled"] = json!(true))).as_deref(),
        Some("127.0.0.1:9317 · stopped by you")
    );
}

#[test]
fn a_login_item_failure_outranks_every_other_notice() {
    let mut m = model(|_| {});
    m.action = ActionState::Failed("service start failed".into());
    m.login_item_error = Some("Launch at login: denied".into());
    assert_eq!(notice(&m).as_deref(), Some("Launch at login: denied"));
}

#[test]
fn the_headline_tells_stopped_from_running() {
    assert_eq!(headline(&model(|_| {})), "Running 0.36.0");
    assert_eq!(
        headline(&model(|v| {
            v["job"]["pid"] = Value::Null;
            v["instance"]["reachable"] = json!(false);
        })),
        "Stopped"
    );
}

#[test]
fn a_live_health_answer_outranks_a_stale_unreachable_discovery() {
    let mut model = model(|v| {
        v["job"]["pid"] = Value::Null;
        v["instance"]["reachable"] = json!(false);
    });
    assert!(is_down(&model));
    // The probe answered after discovery; its rediscovery failed, so the old discovery stays.
    model.health.record(true);
    assert!(!is_down(&model));
}

#[test]
fn actions_in_flight_read_as_words() {
    let mut m = model(|_| {});
    m.action = ActionState::Automatic(crate::connect::policy::AutoAction::RestartForVersion);
    assert_eq!(notice(&m).as_deref(), Some("Automatic restart for new version…"));
    m.action = ActionState::Running(crate::connect::policy::UserAction::InstallAndStart);
    assert_eq!(notice(&m).as_deref(), Some("Install and start…"));
}
