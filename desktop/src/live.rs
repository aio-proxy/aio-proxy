use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopLive {
    #[serde(deserialize_with = "decimal")]
    pub today_tokens: u128,
    #[serde(deserialize_with = "decimal")]
    pub today_cost_nano_usd: u128,
    pub in_flight: u64,
    pub output_tokens_per_second: f64,
}

/// Counts are decimal integer strings on the wire (they can exceed 2^53).
fn decimal<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u128, D::Error> {
    let text = String::deserialize(deserializer)?;
    text.parse::<u128>().map_err(serde::de::Error::custom)
}

pub fn parse(body: &[u8]) -> Result<DesktopLive, String> {
    #[derive(Deserialize)]
    struct Response {
        version: u64,
        #[serde(flatten)]
        live: DesktopLive,
    }

    let response: Response = serde_json::from_slice(body).map_err(|error| error.to_string())?;
    if response.version != 1 {
        return Err(format!("unsupported desktop live version: {}", response.version));
    }
    let rate = response.live.output_tokens_per_second;
    if !rate.is_finite() || rate < 0.0 {
        return Err("outputTokensPerSecond must be finite and non-negative".to_string());
    }
    Ok(response.live)
}

#[cfg(test)]
mod tests;
