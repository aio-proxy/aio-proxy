use std::cmp::Ordering;

use super::*;

#[test]
fn compares_by_semver_precedence_not_string_order() {
    assert_eq!(compare("0.9.0", "0.10.0"), Some(Ordering::Less));
    assert_eq!(compare("0.36.0", "0.37.0"), Some(Ordering::Less));
    assert_eq!(compare("0.37.0", "0.37.0"), Some(Ordering::Equal));
    assert_eq!(compare("1.0.0", "0.99.9"), Some(Ordering::Greater));
}

#[test]
fn a_prerelease_is_older_than_its_release() {
    assert_eq!(compare("0.37.0-canary.20260930", "0.37.0"), Some(Ordering::Less));
}

#[test]
fn an_unparsable_version_is_unknown_not_older() {
    assert_eq!(compare("garbage", "0.37.0"), None);
    assert_eq!(compare("0.37.0", ""), None);
}

#[test]
fn reads_the_version_line_from_cli_output() {
    assert_eq!(parse_version_output("0.37.0\n").as_deref(), Some("0.37.0"));
    assert_eq!(parse_version_output("Unexpected internal error\n"), None);
    assert_eq!(parse_version_output(""), None);
}

#[test]
fn app_version_is_a_valid_semver() {
    assert!(semver::Version::parse(APP_VERSION).is_ok(), "build.rs read {APP_VERSION:?}");
}
