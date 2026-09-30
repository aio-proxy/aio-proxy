use super::*;

const GOLDEN: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/types/src/desktop-summary/fixtures/v1.json"));

fn v1(body: &str) -> SummaryV1 {
    match parse(body.as_bytes()) {
        Parsed::V1(summary) => *summary,
        other => panic!("expected v1, got {other:?}"),
    }
}

#[test]
fn the_golden_fixture_parses() {
    let summary = v1(GOLDEN);
    assert_eq!(summary.server.version, "0.36.0");
    assert_eq!(summary.server.ppid, Some(4310));
    assert_eq!(summary.usage24h.requests, 257);
    assert_eq!(summary.usage24h.estimated_cost_nano_usd, 20_521_353_840);
    assert_eq!(summary.trend7d.len(), 1);
    assert_eq!(summary.activity[0].date, "2026-09-29");
    let codex = &summary.providers[0];
    assert_eq!(codex.state, ProviderState::Ok);
    let Quota::Ready { windows, refresh_failed, .. } = &codex.quota else {
        panic!("codex quota should be ready");
    };
    assert!(!refresh_failed);
    assert_eq!(windows[0].label.text(), "5 hours");
    assert_eq!(windows[0].remaining_ratio, Some(0.4));
    assert!(matches!(summary.providers[1].quota, Quota::Loading));
    assert_eq!(summary.alerts[0].kind, AlertKind::Diagnostic);
    assert!(summary.any_quota_loading());
}

#[test]
fn unknown_fields_are_ignored_everywhere() {
    let mut json: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    json["futureTopLevel"] = serde_json::json!({ "x": 1 });
    json["server"]["startedAt"] = serde_json::json!("2026-09-29T00:00:00Z");
    json["providers"][0]["quota"]["windows"][0]["futureField"] = serde_json::json!(true);
    json["providers"][1]["quota"]["hint"] = serde_json::json!("warming");
    let summary = v1(&json.to_string());
    assert!(matches!(summary.providers[1].quota, Quota::Loading));
}

#[test]
fn unknown_enum_values_map_to_unknown() {
    let mut json: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    json["providers"][0]["state"] = serde_json::json!("rate_limited");
    json["providers"][1]["quota"] = serde_json::json!({ "status": "throttled", "retryAt": "soon" });
    json["alerts"][0]["kind"] = serde_json::json!("budget_warning");
    let summary = v1(&json.to_string());
    assert_eq!(summary.providers[0].state, ProviderState::Unknown);
    assert!(matches!(summary.providers[1].quota, Quota::Unknown));
    assert_eq!(summary.alerts[0].kind, AlertKind::Unknown);
}

#[test]
fn an_unsupported_protocol_version_selects_the_degraded_panel() {
    let body = br#"{ "protocolVersion": 2, "usage": "a shape v1 cannot read" }"#;
    assert!(matches!(classify(200, body), FetchOutcome::Degraded(DegradedReason::UnsupportedVersion(Some(2)))));
    assert!(matches!(
        classify(200, br#"{ "status": "ok" }"#),
        FetchOutcome::Degraded(DegradedReason::UnsupportedVersion(None))
    ));
}

#[test]
fn a_missing_route_selects_the_degraded_panel() {
    assert!(matches!(classify(404, b"Not Found"), FetchOutcome::Degraded(DegradedReason::Missing)));
}

#[test]
fn unauthorized_and_server_errors_are_distinct_outcomes() {
    assert!(matches!(classify(401, br#"{"error":"unauthorized"}"#), FetchOutcome::Unauthorized));
    assert!(matches!(classify(500, b""), FetchOutcome::Failed(_)));
    assert!(matches!(classify(200, b"<html>"), FetchOutcome::Failed(_)));
}

#[test]
fn a_count_beyond_2_pow_53_survives() {
    let mut json: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    json["usage24h"]["inputTokens"] = serde_json::json!("18014398509481985");
    assert_eq!(v1(&json.to_string()).usage24h.input_tokens, 18_014_398_509_481_985);
}
