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
    let mut model = super::AppModel::new(crate::install::Paths::for_home(std::path::Path::new("/Users/me")), None);
    model.summary_error = Some((UsageRange::H24, "timed out".into()));
    assert_eq!(model.usage_error(), Some("timed out"));
    model.usage_range = UsageRange::D7;
    assert_eq!(model.usage_error(), None);
}
