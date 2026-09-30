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
fn ownership_explains_why_the_app_will_not_act() {
    assert!(notice(&model(|v| v["unit"]["owner"] = json!("external"))).unwrap().contains("CLI"));
    assert!(notice(&model(|v| v["job"]["disabled"] = json!(true))).unwrap().contains("Stopped by you"));
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
fn actions_in_flight_read_as_words() {
    let mut m = model(|_| {});
    m.action = ActionState::Automatic(crate::connect::policy::AutoAction::RestartForVersion);
    assert_eq!(notice(&m).as_deref(), Some("Automatic restart for new version…"));
    m.action = ActionState::Running(crate::connect::policy::UserAction::InstallAndStart);
    assert_eq!(notice(&m).as_deref(), Some("Install and start…"));
}
