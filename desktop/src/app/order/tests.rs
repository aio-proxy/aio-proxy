use super::*;

#[test]
fn a_discovery_started_mid_action_cannot_overwrite_the_actions_result() {
    let mut order = DiscoveryOrder::default();
    let mid_action = order.issue();
    // The action completes: its `after` takes the newest number and is applied first.
    let after = order.issue();
    assert!(order.accept(after));
    // The slower mid-action discovery lands afterwards and is dropped.
    assert!(!order.accept(mid_action));
}

#[test]
fn results_landing_in_order_are_all_applied_and_a_repeat_is_not() {
    let mut order = DiscoveryOrder::default();
    let first = order.issue();
    let second = order.issue();
    assert!(order.accept(first));
    assert!(order.accept(second));
    assert!(!order.accept(second));
}
