use super::fixture::{SPEC_EXAMPLE, discovery_with as with};
use super::*;

#[test]
fn parses_the_spec_example() {
    let d = parse_discovery(SPEC_EXAMPLE.as_bytes()).unwrap();
    assert_eq!(d.bundled_version, "0.37.0");
    assert_eq!(d.unit.owner, Owner::Desktop);
    assert_eq!(d.unit.home.as_deref(), Some("/Users/me/.aio-proxy"));
    assert_eq!(d.job.pid, Some(4310));
    assert!(!d.job.disabled);
    assert_eq!(d.instance.matches_job, Some(true));
    assert_eq!(d.token.as_ref().map(Token::expose), Some("tok-abc"));
}

#[test]
fn owner_null_without_a_plist_is_the_only_fresh_install_signal() {
    let d = with(|v| {
        v["unit"] =
            serde_json::json!({ "present": false, "wrapperValid": false, "target": null, "home": null, "owner": null });
    })
    .unwrap();
    assert_eq!(d.unit.owner, Owner::NoPlist);
}

#[test]
fn every_other_owner_shape_fails_closed_to_unknown() {
    let null_but_present = with(|v| v["unit"]["owner"] = serde_json::Value::Null).unwrap();
    assert_eq!(null_but_present.unit.owner, Owner::Unknown);
    let missing = with(|v| {
        v["unit"].as_object_mut().unwrap().remove("owner");
    })
    .unwrap();
    assert_eq!(missing.unit.owner, Owner::Unknown);
    let future = with(|v| v["unit"]["owner"] = serde_json::json!("desktop-v2")).unwrap();
    assert_eq!(future.unit.owner, Owner::Unknown);
    let external = with(|v| v["unit"]["owner"] = serde_json::json!("external")).unwrap();
    assert_eq!(external.unit.owner, Owner::External);
}

#[test]
fn a_missing_disabled_flag_reads_as_disabled() {
    let d = with(|v| {
        v["job"].as_object_mut().unwrap().remove("disabled");
    })
    .unwrap();
    assert!(d.job.disabled);
}

#[test]
fn matches_job_null_stays_unknown() {
    let d = with(|v| v["instance"]["matchesJob"] = serde_json::Value::Null).unwrap();
    assert_eq!(d.instance.matches_job, None);
}

#[test]
fn rejects_another_protocol_version_and_non_json() {
    assert!(with(|v| v["protocolVersion"] = serde_json::json!(2)).is_err());
    assert!(parse_discovery(b"").is_err());
    assert!(parse_discovery(b"Unexpected internal error").is_err());
    assert!(parse_discovery(format!("{SPEC_EXAMPLE}\n{{}}").as_bytes()).is_err());
}

#[test]
fn neither_errors_nor_debug_output_leak_the_token() {
    let d = parse_discovery(SPEC_EXAMPLE.as_bytes()).unwrap();
    assert!(!format!("{d:?}").contains("tok-abc"));
    let broken = SPEC_EXAMPLE.replace("\"bundledVersion\": \"0.37.0\"", "\"bundledVersion\": 7");
    let error = parse_discovery(broken.as_bytes()).unwrap_err();
    assert!(!error.contains("tok-abc"), "{error}");
}
