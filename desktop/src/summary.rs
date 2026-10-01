//! `DesktopSummaryV1` (packages/types/src/desktop-summary) as the app reads it: `protocolVersion`
//! first, unknown fields ignored, unknown enum values mapped to `Unknown`.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryV1 {
    pub generated_at: String,
    pub server: ServerInfo,
    pub usage: Usage,
    #[serde(default)]
    pub activity: Vec<ActivityDay>,
    #[serde(default)]
    pub providers: Vec<Provider>,
    #[serde(default)]
    pub alerts: Vec<Alert>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerInfo {
    pub version: String,
    pub pid: u32,
    #[serde(default)]
    pub ppid: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
pub enum UsageRange {
    #[serde(rename = "24h")]
    H24,
    #[serde(rename = "7d")]
    D7,
    #[serde(rename = "30d")]
    D30,
}

impl UsageRange {
    pub const ALL: [UsageRange; 3] = [UsageRange::H24, UsageRange::D7, UsageRange::D30];

    /// The `?range=` value; also the segmented control's label.
    pub fn query(self) -> &'static str {
        match self {
            UsageRange::H24 => "24h",
            UsageRange::D7 => "7d",
            UsageRange::D30 => "30d",
        }
    }

    pub fn label(self) -> &'static str {
        self.query()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BucketUnit {
    Hour,
    Day,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub range: UsageRange,
    pub bucket_unit: BucketUnit,
    pub range_start: String,
    pub range_end: String,
    pub current: UsageTotals,
    pub previous: UsageTotals,
    #[serde(default)]
    pub buckets: Vec<UsageBucket>,
    #[serde(default)]
    pub by_model: Vec<ModelUsage>,
    #[serde(default)]
    pub by_provider: Vec<ProviderUsage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    #[serde(deserialize_with = "decimal")]
    pub requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub failed_requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub input_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub output_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub estimated_cost_nano_usd: u128,
    pub pricing_coverage: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSlice {
    #[serde(deserialize_with = "decimal")]
    pub requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub failed_requests: u128,
    #[serde(deserialize_with = "decimal")]
    pub total_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub estimated_cost_nano_usd: u128,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UsageBucket {
    pub start: String,
    #[serde(flatten)]
    pub slice: UsageSlice,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    pub model_id: String,
    #[serde(flatten)]
    pub slice: UsageSlice,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub provider_id: String,
    pub name: String,
    #[serde(flatten)]
    pub slice: UsageSlice,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDay {
    pub date: String,
    #[serde(deserialize_with = "decimal")]
    pub total_tokens: u128,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    #[serde(default, rename = "accountLabel")]
    pub account_label: Option<String>,
    pub state: ProviderState,
    pub diagnostic: Option<Diagnostic>,
    pub quota: Quota,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderState {
    Ok,
    Degraded,
    Unavailable,
    Disabled,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub summary: String,
    #[serde(default, rename = "suggestedCommand")]
    pub suggested_command: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Quota {
    None,
    Unsupported,
    Loading,
    Failed,
    Ready {
        #[serde(rename = "sampledAt")]
        sampled_at: String,
        #[serde(rename = "refreshFailed")]
        refresh_failed: bool,
        #[serde(default)]
        plan: Option<LocalizedText>,
        windows: Vec<QuotaWindow>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub id: String,
    pub label: LocalizedText,
    pub remaining_ratio: Option<f64>,
    pub resets_at: Option<String>,
    pub window_minutes: Option<u32>,
}

/// A label is either plain text or a map of language tags that always carries `default`.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum LocalizedText {
    Plain(String),
    Localized(BTreeMap<String, String>),
}

impl LocalizedText {
    /// The panel is English-only, so it shows the `default` entry.
    pub fn text(&self) -> &str {
        match self {
            LocalizedText::Plain(text) => text,
            LocalizedText::Localized(map) => {
                map.get("default").or_else(|| map.values().next()).map_or("", String::as_str)
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub provider_id: String,
    pub kind: AlertKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertKind {
    Diagnostic,
    QuotaExhausted,
    #[serde(other)]
    Unknown,
}

impl SummaryV1 {
    /// Drives the refresh policy's one shared refetch after 2 s.
    pub fn any_quota_loading(&self) -> bool {
        self.providers.iter().any(|p| matches!(p.quota, Quota::Loading))
    }
}

/// Counts are decimal integer strings on the wire (they can exceed 2^53).
fn decimal<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
    let text = String::deserialize(deserializer)?;
    text.parse::<u128>().map_err(serde::de::Error::custom)
}

#[derive(Debug)]
pub enum Parsed {
    V1(Box<SummaryV1>),
    /// A `protocolVersion` this app does not know (or none at all): degraded panel.
    Unsupported(Option<u64>),
    Invalid(String),
}

/// Reads `protocolVersion` before anything else, so a future body shape never reaches the v1 parser.
pub fn parse(body: &[u8]) -> Parsed {
    #[derive(Deserialize)]
    struct Probe {
        #[serde(rename = "protocolVersion")]
        protocol_version: Option<serde_json::Value>,
    }
    let probe: Probe = match serde_json::from_slice(body) {
        Ok(probe) => probe,
        Err(error) => return Parsed::Invalid(error.to_string()),
    };
    match probe.protocol_version.as_ref().and_then(serde_json::Value::as_u64) {
        Some(1) => match serde_json::from_slice::<SummaryV1>(body) {
            Ok(summary) => Parsed::V1(Box::new(summary)),
            Err(error) => Parsed::Invalid(error.to_string()),
        },
        other => Parsed::Unsupported(other),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DegradedReason {
    /// 404: an instance older than `desktop-summary`.
    Missing,
    UnsupportedVersion(Option<u64>),
    /// Discovery found no desktop token (an older proxy that never writes one, or a file failing
    /// its checks), so no summary request is sent.
    NoToken,
}

#[derive(Debug)]
pub enum FetchOutcome {
    Summary(Box<SummaryV1>),
    Degraded(DegradedReason),
    /// 401: re-run discovery once to pick up a replaced token, then report "authentication failed".
    Unauthorized,
    Failed(String),
}

/// Maps one `GET /dashboard/api/desktop-summary` response to what the panel shows.
pub fn classify(status: u16, body: &[u8]) -> FetchOutcome {
    match status {
        200 => match parse(body) {
            Parsed::V1(summary) => FetchOutcome::Summary(summary),
            Parsed::Unsupported(version) => FetchOutcome::Degraded(DegradedReason::UnsupportedVersion(version)),
            Parsed::Invalid(error) => FetchOutcome::Failed(format!("invalid desktop summary: {error}")),
        },
        401 => FetchOutcome::Unauthorized,
        404 => FetchOutcome::Degraded(DegradedReason::Missing),
        other => FetchOutcome::Failed(format!("desktop summary answered HTTP {other}")),
    }
}

#[cfg(test)]
mod tests;
