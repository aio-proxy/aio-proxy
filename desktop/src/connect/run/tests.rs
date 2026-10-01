use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::*;
use crate::connect::discovery::fixture::discovery;

/// Scripted host: discoveries, liveness and health answers are consumed in order (the last one
/// repeats); sleeping advances a fake clock.
struct Fake {
    discoveries: RefCell<VecDeque<Discovery>>,
    alive: RefCell<VecDeque<bool>>,
    health: RefCell<VecDeque<Option<String>>>,
    mutations: RefCell<Vec<(Mutation, Option<String>)>>,
    clock: Cell<Instant>,
    fail_mutations: Cell<bool>,
}

fn next<T: Clone>(queue: &RefCell<VecDeque<T>>) -> T {
    let mut queue = queue.borrow_mut();
    if queue.len() > 1 { queue.pop_front().unwrap() } else { queue.front().cloned().expect("script ran dry") }
}

impl Fake {
    fn new(discoveries: Vec<Discovery>) -> Self {
        Self {
            discoveries: RefCell::new(discoveries.into()),
            alive: RefCell::new(VecDeque::from([false])),
            // Something healthy answers unless a test says otherwise, so starts complete at once.
            health: RefCell::new(VecDeque::from([Some("0.37.0".to_string())])),
            mutations: RefCell::default(),
            clock: Cell::new(Instant::now()),
            fail_mutations: Cell::new(false),
        }
    }

    fn mutations(&self) -> Vec<Mutation> {
        self.mutations.borrow().iter().map(|(m, _)| *m).collect()
    }
}

impl Host for Fake {
    fn discover(&self) -> Result<Discovery, String> {
        Ok(next(&self.discoveries))
    }
    fn mutate(&self, mutation: Mutation, home: Option<&str>) -> Result<(), String> {
        self.mutations.borrow_mut().push((mutation, home.map(str::to_string)));
        if self.fail_mutations.get() { Err("service start failed (exit 1)".into()) } else { Ok(()) }
    }
    fn pid_alive(&self, _pid: u32) -> bool {
        next(&self.alive)
    }
    fn health_version(&self, _control_url: &str) -> Option<String> {
        next(&self.health)
    }
    fn reload(&self, _control_url: &str) -> ReloadOutcome {
        ReloadOutcome::Reloaded
    }
    fn sleep(&self, duration: Duration) {
        self.clock.set(self.clock.get() + duration);
    }
    fn now(&self) -> Instant {
        self.clock.get()
    }
}

fn stopped(v: &mut Value) {
    v["job"]["pid"] = Value::Null;
    v["instance"]["reachable"] = json!(false);
    v["instance"]["pid"] = Value::Null;
    v["instance"]["matchesJob"] = Value::Null;
}

#[test]
fn a_user_stop_between_discovery_and_an_automatic_start_wins() {
    let decided = discovery(stopped);
    let host = Fake::new(vec![discovery(|v| {
        stopped(v);
        v["job"]["disabled"] = json!(true);
    })]);
    assert_eq!(
        run_auto(&host, &decided, AutoAction::StartNoProcess, &mut AutoAttempts::default()).unwrap_err(),
        RunError::Changed
    );
    assert!(host.mutations().is_empty());
}

#[test]
fn a_click_is_refused_when_the_service_changed_owner() {
    let rendered = discovery(|_| {});
    let host = Fake::new(vec![discovery(|v| v["unit"]["owner"] = json!("external"))]);
    assert_eq!(run_user(&host, &rendered, UserAction::Stop).unwrap_err(), RunError::Changed);
    assert!(host.mutations().is_empty());
}

#[test]
fn install_and_start_run_in_order() {
    let no_plist = |v: &mut Value| {
        v["unit"] = json!({ "present": false, "owner": null });
        stopped(v);
        v["job"]["loaded"] = json!(false);
    };
    let host = Fake::new(vec![discovery(no_plist)]);
    run_auto(&host, &discovery(no_plist), AutoAction::InstallAndStart, &mut AutoAttempts::default()).unwrap();
    assert_eq!(host.mutations(), vec![Mutation::Service("install"), Mutation::Service("start")]);
    assert_eq!(host.mutations.borrow()[0].1, None, "a fresh install uses the default home");
}

#[test]
fn service_commands_carry_the_plist_home() {
    let host = Fake::new(vec![discovery(stopped)]);
    run_user(&host, &discovery(stopped), UserAction::Start).unwrap();
    assert_eq!(host.mutations.borrow()[0], (Mutation::Service("start"), Some("/Users/me/.aio-proxy".into())));
}

#[test]
fn an_external_restart_kickstarts_and_never_rewrites_the_plist() {
    let external = |v: &mut Value| v["unit"]["owner"] = json!("external");
    let host = Fake::new(vec![discovery(external)]);
    *host.health.borrow_mut() = VecDeque::from([Some("0.20.0".to_string())]);
    run_user(&host, &discovery(external), UserAction::Restart).unwrap();
    assert_eq!(host.mutations(), vec![Mutation::Kickstart]);
}

#[test]
fn restart_waits_for_the_old_sidecar_to_die_and_the_new_version_to_answer() {
    let host = Fake::new(vec![discovery(|_| {})]);
    *host.alive.borrow_mut() = VecDeque::from([true, true, false]);
    *host.health.borrow_mut() = VecDeque::from([Some("0.36.0".to_string()), Some("0.37.0".to_string())]);
    let started = host.now();
    run_auto(&host, &discovery(|_| {}), AutoAction::RestartForVersion, &mut AutoAttempts::default()).unwrap();
    assert_eq!(host.mutations(), vec![Mutation::Service("restart")]);
    assert_eq!(host.now() - started, POLL_EVERY * 3, "two polls with the old pid alive, one on the old version");
}

#[test]
fn restart_times_out_when_the_old_sidecar_never_exits() {
    let host = Fake::new(vec![discovery(|_| {})]);
    *host.alive.borrow_mut() = VecDeque::from([true]);
    let started = host.now();
    let error = run_user(&host, &discovery(|_| {}), UserAction::Restart).unwrap_err();
    assert_eq!(error, RunError::TimedOut("restart"));
    let waited = host.now() - started;
    assert!(waited >= RESTART_WAIT && waited <= RESTART_WAIT + POLL_EVERY, "{waited:?}");
}

#[test]
fn stop_waits_for_no_process_and_no_answer() {
    let host = Fake::new(vec![discovery(|_| {}), discovery(|_| {}), discovery(stopped)]);
    let done = run_user(&host, &discovery(|_| {}), UserAction::Stop).unwrap();
    assert_eq!(host.mutations(), vec![Mutation::Service("stop")]);
    assert!(stop_complete(&done));
}

#[test]
fn unknown_owners_get_no_service_action() {
    let unknown = discovery(|v| v["unit"]["owner"] = json!("unknown"));
    let host = Fake::new(vec![unknown.clone()]);
    assert_eq!(run_user(&host, &unknown, UserAction::Restart).unwrap_err(), RunError::NotOffered);
    assert_eq!(run_reload(&host, &unknown).unwrap(), ReloadOutcome::Reloaded);
}

fn no_plist(v: &mut Value) {
    v["unit"] = json!({ "present": false, "owner": null });
    stopped(v);
    v["job"]["loaded"] = json!(false);
}

#[test]
fn a_hand_started_instance_appearing_before_a_fresh_install_aborts_it() {
    let host = Fake::new(vec![discovery(|v| {
        no_plist(v);
        v["instance"]["reachable"] = json!(true);
    })]);
    let mut attempts = AutoAttempts::default();
    let error = run_auto(&host, &discovery(no_plist), AutoAction::InstallAndStart, &mut attempts).unwrap_err();
    assert_eq!(error, RunError::Changed);
    assert!(host.mutations().is_empty());
    assert!(!attempts.used(AutoAction::InstallAndStart), "nothing ran, so the attempt is not spent");
}

#[test]
fn a_failed_automatic_mutation_spends_the_attempt_so_it_is_never_retried() {
    let host = Fake::new(vec![discovery(stopped)]);
    host.fail_mutations.set(true);
    let mut attempts = AutoAttempts::default();
    let error = run_auto(&host, &discovery(stopped), AutoAction::StartNoProcess, &mut attempts).unwrap_err();
    assert!(matches!(error, RunError::Command(_)));
    assert!(attempts.used(AutoAction::StartNotLoaded), "the slot is shared across rows");
    let again = run_auto(&host, &discovery(stopped), AutoAction::StartNoProcess, &mut attempts);
    assert_eq!(again.unwrap_err(), RunError::NotOffered);
    assert_eq!(host.mutations().len(), 1);
}

#[test]
fn an_explicit_install_click_installs_then_starts() {
    let host = Fake::new(vec![discovery(no_plist)]);
    run_user(&host, &discovery(no_plist), UserAction::InstallAndStart).unwrap();
    assert_eq!(host.mutations(), vec![Mutation::Service("install"), Mutation::Service("start")]);
}

#[test]
fn an_install_click_is_refused_when_the_service_is_not_a_fresh_install() {
    for owner in ["external", "unknown"] {
        let existing = discovery(|v| v["unit"]["owner"] = json!(owner));
        let host = Fake::new(vec![existing.clone()]);
        assert_eq!(run_user(&host, &existing, UserAction::InstallAndStart).unwrap_err(), RunError::NotOffered);
        assert!(host.mutations().is_empty());
    }
}

#[test]
fn an_install_click_is_refused_when_an_instance_started_meanwhile() {
    let host = Fake::new(vec![discovery(|v| {
        no_plist(v);
        v["instance"]["reachable"] = json!(true);
    })]);
    assert_eq!(run_user(&host, &discovery(no_plist), UserAction::InstallAndStart).unwrap_err(), RunError::Changed);
    assert!(host.mutations().is_empty());
}

#[test]
fn a_start_waits_for_health_and_fails_when_the_proxy_never_answers() {
    let host = Fake::new(vec![discovery(stopped)]);
    *host.health.borrow_mut() = VecDeque::from([None, None, Some("0.37.0".to_string())]);
    let started = host.now();
    run_user(&host, &discovery(stopped), UserAction::Start).unwrap();
    assert_eq!(host.now() - started, POLL_EVERY * 2, "two polls before /health answered");

    *host.health.borrow_mut() = VecDeque::from([None]);
    let started = host.now();
    let error = run_auto(&host, &discovery(stopped), AutoAction::StartNoProcess, &mut AutoAttempts::default());
    assert_eq!(error.unwrap_err(), RunError::TimedOut("start"));
    let waited = host.now() - started;
    assert!(waited >= START_WAIT && waited <= START_WAIT + POLL_EVERY, "{waited:?}");
}
