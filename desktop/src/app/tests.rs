use super::ActionState;
use crate::connect::policy::AutoAction;
use crate::connect::run::RunError;

#[test]
fn an_automatic_action_that_found_the_service_changed_leaves_nothing_on_screen() {
    let action = AutoAction::RestartForVersion;
    assert_eq!(ActionState::after_automatic_failure(action, &RunError::Changed), ActionState::Idle);
    assert_eq!(
        ActionState::after_automatic_failure(action, &RunError::TimedOut("restart")),
        ActionState::Failed("Automatic restart for new version failed: restart did not finish in time".into())
    );
}

#[test]
fn closing_the_panel_clears_done_and_failed_but_not_work_in_flight() {
    for (before, after) in [
        (ActionState::Done("Stop finished.".into()), ActionState::Idle),
        (ActionState::Failed("start did not finish in time".into()), ActionState::Idle),
        (ActionState::Automatic(AutoAction::StartNotLoaded), ActionState::Automatic(AutoAction::StartNotLoaded)),
    ] {
        let mut state = before;
        state.clear_outcome();
        assert_eq!(state, after);
    }
}

#[test]
fn a_failed_fetch_is_reported_only_for_the_window_it_was_for() {
    use crate::summary::UsageRange;
    let mut model =
        super::AppModel::new(crate::platform::paths_from(std::path::Path::new("/Users/me"), |_| None), None);
    model.summary_error = Some((UsageRange::H24, "timed out".into()));
    assert_eq!(model.usage_error(), Some("timed out"));
    model.usage_range = UsageRange::D7;
    assert_eq!(model.usage_error(), None);
}

fn golden_7d() -> Box<crate::summary::SummaryV1> {
    const GOLDEN: &str =
        include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/types/src/desktop-summary/fixtures/v1.json"));
    match crate::summary::parse(GOLDEN.as_bytes()) {
        crate::summary::Parsed::V1(summary) => summary,
        _ => panic!("the golden fixture must parse"),
    }
}

#[test]
fn a_summary_for_another_window_is_cached_under_its_own_range() {
    use crate::summary::UsageRange;
    let mut model =
        super::AppModel::new(crate::platform::paths_from(std::path::Path::new("/Users/me"), |_| None), None);
    model.summary_error = Some((UsageRange::D7, "timed out".into()));
    // The 24h window is on screen while a 7d response lands.
    model.accept_summary(golden_7d());
    assert!(model.usage_for(UsageRange::D7).is_some());
    assert!(model.usage_for(UsageRange::H24).is_none());
    assert_eq!(model.usage_error(), None);
    assert!(model.summary_error.is_none());
    model.forget_usage();
    assert!(model.usage_for(UsageRange::D7).is_none());
}

#[test]
fn only_macos_needs_an_applications_bundle_to_offer_aiop() {
    let mut model = super::AppModel::new(
        crate::platform::paths_from(std::path::Path::new("/Users/me"), |_| None),
        Some("/Users/me/Apps/AIO Proxy.AppImage".into()),
    );
    model.install = Some(crate::install::InstallState::Persistent);
    assert_eq!(model.can_link_cli(), !cfg!(target_os = "macos"));
}

#[test]
fn an_up_to_date_check_only_sets_the_action_line_and_never_interrupts_a_service_action() {
    use crate::connect::policy::UserAction;
    let mut model =
        super::AppModel::new(crate::platform::paths_from(std::path::Path::new("/Users/me"), |_| None), None);
    model.update_pending = Some("0.41.0".into());
    let up_to_date = ActionState::Done("AIO Proxy is up to date.".into());
    model.show_update_outcome(up_to_date.clone());
    assert_eq!(model.action, up_to_date);
    assert_eq!(model.update_pending.as_deref(), Some("0.41.0"));
    model.action = ActionState::Running(UserAction::Restart);
    model.show_update_outcome(up_to_date);
    assert_eq!(model.action, ActionState::Running(UserAction::Restart));
}
