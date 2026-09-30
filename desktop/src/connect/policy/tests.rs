use serde_json::{Value, json};

use super::*;
use crate::connect::discovery::fixture::discovery;

fn none() -> AutoAttempts {
    AutoAttempts::default()
}

fn auto(patch: impl FnOnce(&mut Value)) -> Option<AutoAction> {
    automatic_action(&discovery(patch), true, &none())
}

fn no_plist(v: &mut Value) {
    v["unit"] = json!({ "present": false, "wrapperValid": false, "target": null, "home": null, "owner": null });
    v["job"] = json!({ "loaded": false, "disabled": false, "pid": null });
    v["instance"] = json!({ "controlUrl": "http://127.0.0.1:9317", "reachable": false, "matchesJob": null });
}

fn stopped_process(v: &mut Value) {
    v["job"]["pid"] = Value::Null;
    v["instance"]["reachable"] = json!(false);
    v["instance"]["pid"] = Value::Null;
    v["instance"]["matchesJob"] = Value::Null;
}

#[test]
fn no_plist_installs_and_starts() {
    assert_eq!(auto(no_plist), Some(AutoAction::InstallAndStart));
}

#[test]
fn no_plist_with_a_hand_started_instance_on_the_port_is_left_alone() {
    assert_eq!(
        auto(|v| {
            no_plist(v);
            v["instance"]["reachable"] = json!(true);
        }),
        None
    );
}

#[test]
fn an_uninstalled_service_left_disabled_is_not_reinstalled_automatically_but_can_be_by_the_user() {
    let d = discovery(|v| {
        no_plist(v);
        v["job"]["disabled"] = json!(true);
    });
    assert_eq!(automatic_action(&d, true, &none()), None);
    assert_eq!(offered_actions(&d, true), Offered { install: true, ..Offered::default() });
    assert_eq!(offered_actions(&d, false), Offered::default());
    assert_eq!(
        user_mutations(UserAction::InstallAndStart, Owner::NoPlist),
        Some(auto_mutations(AutoAction::InstallAndStart))
    );
    assert_eq!(user_mutations(UserAction::InstallAndStart, Owner::Desktop), None);
}

#[test]
fn a_plist_deleted_while_loaded_or_running_is_not_installed_over() {
    for patch in
        [(|v: &mut Value| v["job"]["loaded"] = json!(true)) as fn(&mut Value), |v| v["job"]["pid"] = json!(4310)]
    {
        let d = discovery(|v| {
            no_plist(v);
            patch(v);
        });
        assert_eq!(automatic_action(&d, true, &none()), None);
        assert!(!offered_actions(&d, true).install);
        let d = discovery(|v| {
            no_plist(v);
            patch(v);
            v["job"]["disabled"] = json!(true);
        });
        assert!(!offered_actions(&d, true).install);
    }
}

#[test]
fn nothing_is_installed_when_the_control_address_was_not_probed() {
    let patch = |v: &mut Value| {
        no_plist(v);
        v["instance"]["controlUrl"] = Value::Null;
    };
    assert_eq!(auto(patch), None);
    assert!(!offered_actions(&discovery(patch), true).install);
}

#[test]
fn desktop_loaded_enabled_without_a_process_is_started() {
    assert_eq!(auto(stopped_process), Some(AutoAction::StartNoProcess));
}

#[test]
fn desktop_not_loaded_but_enabled_is_started() {
    assert_eq!(
        auto(|v| {
            stopped_process(v);
            v["job"]["loaded"] = json!(false);
        }),
        Some(AutoAction::StartNotLoaded)
    );
}

#[test]
fn a_user_stopped_desktop_service_is_never_started() {
    assert_eq!(
        auto(|v| {
            stopped_process(v);
            v["job"]["loaded"] = json!(false);
            v["job"]["disabled"] = json!(true);
        }),
        None
    );
}

#[test]
fn an_older_running_desktop_instance_is_restarted() {
    assert_eq!(auto(|_| {}), Some(AutoAction::RestartForVersion));
}

#[test]
fn a_same_or_newer_running_instance_is_never_downgraded() {
    for version in ["0.37.0", "0.38.0", "not-a-version"] {
        assert_eq!(auto(|v| v["instance"]["version"] = json!(version)), None, "{version}");
    }
}

#[test]
fn external_unknown_and_mismatched_instances_are_never_touched() {
    for owner in ["external", "unknown"] {
        assert_eq!(auto(|v| v["unit"]["owner"] = json!(owner)), None, "{owner}");
        assert_eq!(
            auto(|v| {
                v["unit"]["owner"] = json!(owner);
                stopped_process(v);
            }),
            None,
            "{owner}"
        );
    }
    assert_eq!(auto(|v| v["instance"]["matchesJob"] = json!(false)), None);
    assert_eq!(auto(|v| v["instance"]["matchesJob"] = Value::Null), None, "unknown counts as not matching");
}

#[test]
fn nothing_is_automatic_outside_a_persistent_install() {
    assert_eq!(automatic_action(&discovery(no_plist), false, &none()), None);
    assert_eq!(automatic_action(&discovery(stopped_process), false, &none()), None);
}

#[test]
fn one_automatic_mutation_per_launch_blocks_every_other_row() {
    let rows = [
        discovery(no_plist),
        discovery(|v| {
            stopped_process(v);
            v["job"]["loaded"] = json!(false);
        }),
        discovery(stopped_process),
        discovery(|_| {}),
    ];
    let actions = [
        AutoAction::InstallAndStart,
        AutoAction::StartNotLoaded,
        AutoAction::StartNoProcess,
        AutoAction::RestartForVersion,
    ];
    for (marked, _) in actions.iter().enumerate() {
        let mut attempts = none();
        attempts.mark(actions[marked]);
        for row in &rows {
            assert_eq!(automatic_action(row, true, &attempts), None, "after {:?}", actions[marked]);
        }
    }
}

#[test]
fn restart_uses_kickstart_for_external_and_service_restart_only_for_desktop() {
    assert_eq!(user_mutations(UserAction::Restart, Owner::Desktop), Some(&[Mutation::Service("restart")][..]));
    assert_eq!(user_mutations(UserAction::Restart, Owner::External), Some(&[Mutation::Kickstart][..]));
    for action in [UserAction::Start, UserAction::Restart, UserAction::Stop] {
        assert_eq!(user_mutations(action, Owner::Unknown), None);
        assert_eq!(user_mutations(action, Owner::NoPlist), None);
    }
    assert_eq!(user_mutations(UserAction::Start, Owner::External), Some(&[Mutation::Service("start")][..]));
}

#[test]
fn buttons_follow_ownership_and_running_state() {
    let running = offered_actions(&discovery(|_| {}), true);
    assert_eq!(running, Offered { install: false, start: false, restart: true, stop: true, reload: true });
    let stopped = offered_actions(&discovery(stopped_process), true);
    assert_eq!(stopped, Offered { install: false, start: true, restart: false, stop: false, reload: false });
    let unknown = offered_actions(&discovery(|v| v["unit"]["owner"] = json!("unknown")), true);
    assert_eq!(unknown, Offered { reload: true, ..Offered::default() });
    let read_only = offered_actions(&discovery(|_| {}), false);
    assert_eq!(read_only, Offered { reload: true, ..Offered::default() });
}

#[test]
fn a_changed_owner_match_or_disabled_flag_invalidates_the_decision() {
    let before = discovery(|_| {});
    assert!(unchanged(&before, &discovery(|v| v["job"]["pid"] = json!(9999))));
    assert!(!unchanged(&before, &discovery(|v| v["unit"]["owner"] = json!("external"))));
    assert!(!unchanged(&before, &discovery(|v| v["instance"]["matchesJob"] = json!(false))));
    assert!(!unchanged(&before, &discovery(|v| v["job"]["disabled"] = json!(true))));
}

#[test]
fn restart_completes_only_after_the_old_pid_is_gone_and_the_version_matches() {
    assert!(!restart_complete(true, Some("0.37.0"), Some("0.37.0")), "old sidecar still alive");
    assert!(!restart_complete(false, Some("0.36.0"), Some("0.37.0")), "old binary still serving");
    assert!(!restart_complete(false, None, Some("0.37.0")), "nothing answers yet");
    assert!(restart_complete(false, Some("0.37.0"), Some("0.37.0")));
    assert!(restart_complete(false, Some("0.35.0"), None), "external: any version");
}

#[test]
fn stop_completes_when_no_process_runs_and_nothing_answers() {
    assert!(!stop_complete(&discovery(|_| {})));
    assert!(stop_complete(&discovery(stopped_process)));
}

#[test]
fn reload_reports_the_409_error_and_stage() {
    assert_eq!(parse_reload(200, br#"{"ok":true,"diff":{}}"#), ReloadOutcome::Reloaded);
    assert_eq!(
        parse_reload(409, br#"{"ok":false,"error":"providers.x: bad key","stage":"validate"}"#),
        ReloadOutcome::Rejected { error: "providers.x: bad key".into(), stage: Some("validate".into()) }
    );
    assert!(matches!(parse_reload(403, b"Forbidden"), ReloadOutcome::Failed(_)));
}
