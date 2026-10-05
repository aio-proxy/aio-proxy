use super::*;

const GOLDEN: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../packages/types/src/desktop-live/fixtures/v1.json"));

#[test]
fn the_golden_fixture_parses() {
    let live = parse(GOLDEN.as_bytes()).unwrap();
    assert_eq!(live.today_tokens, 1_234_567);
    assert_eq!(live.today_cost_nano_usd, 3_410_000_000);
    assert_eq!(live.in_flight, 2);
    assert_eq!(live.output_tokens_per_second, 48.3);
}

#[test]
fn the_maximum_u128_token_count_survives() {
    let body = GOLDEN.replace("1234567", "340282366920938463463374607431768211455");
    assert_eq!(parse(body.as_bytes()).unwrap().today_tokens, u128::MAX);
}

#[test]
fn an_unsupported_version_is_rejected() {
    let mut json: serde_json::Value = serde_json::from_str(GOLDEN).unwrap();
    json["version"] = serde_json::json!(2);
    assert!(parse(json.to_string().as_bytes()).is_err());
}

#[test]
fn a_negative_token_rate_is_rejected() {
    let body = GOLDEN.replace("48.3", "-1");
    assert!(parse(body.as_bytes()).is_err());
}

#[test]
fn nonfinite_token_rates_are_rejected() {
    for rate in ["1e400", "-1e400", "NaN", "Infinity", "-Infinity"] {
        let body = GOLDEN.replace("48.3", rate);
        assert!(parse(body.as_bytes()).is_err(), "accepted token rate {rate}");
    }
}
