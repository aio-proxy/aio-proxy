use std::path::Path;

use super::*;

#[test]
fn background_checks_stay_silent_unless_newer_and_manual_checks_report_up_to_date() {
    assert_eq!(
        decide_check("0.40.0", Some(("0.41.0", "linux-x86_64")), false),
        CheckOutcome::Available("0.41.0".into())
    );
    assert_eq!(decide_check("0.40.0", Some(("0.40.0", "linux-x86_64")), false), CheckOutcome::Silent);
    assert_eq!(decide_check("0.40.0", Some(("0.40.0", "linux-x86_64")), true), CheckOutcome::UpToDate);
    assert_eq!(decide_check("0.40.0", None, true), CheckOutcome::UpToDate);
    assert_eq!(decide_check("0.40.0", Some(("0.39.0", "linux-x86_64")), true), CheckOutcome::UpToDate);
}

#[test]
fn an_appimage_that_cannot_be_replaced_opens_that_version_release_page() {
    let a = Path::new("/opt/AIO Proxy.AppImage");
    assert_eq!(
        install_action(Some(a), |_| false, "0.41.0"),
        InstallAction::OpenUrl("https://github.com/aio-proxy/aio-proxy/releases/tag/v0.41.0".into())
    );
    assert_eq!(install_action(Some(a), |d| d == Path::new("/opt"), "0.41.0"), InstallAction::InPlace);
    assert!(matches!(install_action(None, |_| true, "0.41.0"), InstallAction::OpenUrl(_)));
}
