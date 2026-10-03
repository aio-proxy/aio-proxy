/// Settings > Startup apps and Task Manager disable a `Run` entry by writing a REG_BINARY under
/// `Explorer\StartupApproved\Run` and leaving the `Run` value in place: an odd first byte means
/// disabled (`03 00…`), an even one enabled (`02 00…`).
pub fn startup_approved_disabled(bytes: &[u8]) -> bool {
    bytes.first().is_some_and(|flag| flag % 2 == 1)
}

#[test]
fn an_odd_first_byte_marks_the_entry_disabled() {
    assert!(startup_approved_disabled(&[3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert!(!startup_approved_disabled(&[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert!(!startup_approved_disabled(&[]));
}
