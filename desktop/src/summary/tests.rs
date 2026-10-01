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
    let usage = &summary.usage;
    assert_eq!(usage.range, UsageRange::D7);
    assert_eq!(usage.bucket_unit, BucketUnit::Day);
    assert_eq!(usage.current.requests, 257);
    assert_eq!(usage.current.estimated_cost_nano_usd, 20_521_353_840);
    assert_eq!(usage.previous.pricing_coverage, Some(0.5));
    assert_eq!(usage.buckets[0].slice.failed_requests, 53);
    assert_eq!(usage.by_model[0].model_id, "gpt-5.2-codex");
    assert_eq!(usage.by_provider[0].name, "Codex");
    assert_eq!(summary.activity[0].date, "2026-09-29");
    let codex = &summary.providers[0];
    assert_eq!(codex.state, ProviderState::Ok);
    assert_eq!(codex.account_label.as_deref(), Some("you@example.com"));
    let Quota::Ready { windows, refresh_failed, plan, .. } = &codex.quota else {
        panic!("codex quota should be ready");
    };
    assert!(!refresh_failed);
    assert_eq!(plan.as_ref().map(LocalizedText::text), Some("Pro"));
    assert_eq!(windows[0].label.text(), "5 hours");
    assert_eq!(windows[0].remaining_ratio, Some(0.4));
    let cursor = &summary.providers[1];
    assert_eq!(cursor.account_label, None);
    assert_eq!(
        cursor.diagnostic.as_ref().and_then(|d| d.suggested_command.as_deref()),
        Some("aio-proxy provider login --provider cursor")
    );
    assert!(matches!(cursor.quota, Quota::Loading));
    assert_eq!(summary.alerts[0].kind, AlertKind::Diagnostic);
    assert!(summary.any_quota_loading());
}

#[test]
fn an_unknown_usage_range_is_an_invalid_summary() {
    let mut json: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    json["usage"]["range"] = serde_json::json!("90d");
    assert!(matches!(parse(json.to_string().as_bytes()), Parsed::Invalid(_)));
}

#[test]
fn range_query_values_match_the_server() {
    assert_eq!(UsageRange::ALL.map(UsageRange::query), ["24h", "7d", "30d"]);
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
    json["usage"]["current"]["inputTokens"] = serde_json::json!("18014398509481985");
    assert_eq!(v1(&json.to_string()).usage.current.input_tokens, 18_014_398_509_481_985);
}
