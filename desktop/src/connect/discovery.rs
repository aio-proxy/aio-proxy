//! Parses the one JSON object `aio-proxy __desktop-connect` prints on stdout
//! (packages/cli/src/desktop-connect/desktop-connect.ts). Every ambiguity fails closed: a field the
//! app cannot read never permits more automation than an explicit value would.

use serde::Deserialize;

use crate::token::Token;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Owner {
    /// The plist's wrapper target is this app's symlink.
    Desktop,
    /// A valid wrapper pointing anywhere else (a CLI install).
    External,
    /// Unrecognized wrapper, or anything the app cannot read.
    #[default]
    Unknown,
    /// `owner: null` with `present: false`: no plist, so a fresh install is allowed.
    NoPlist,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Unit {
    #[serde(default = "yes")]
    pub present: bool,
    #[serde(default)]
    pub wrapper_valid: bool,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub home: Option<String>,
    #[serde(skip)]
    pub owner: Owner,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Job {
    #[serde(default)]
    pub loaded: bool,
    /// A missing value reads as disabled: the app must never `enable` a job the user stopped.
    #[serde(default = "yes")]
    pub disabled: bool,
    #[serde(default)]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    #[serde(default)]
    pub control_url: Option<String>,
    #[serde(default)]
    pub dashboard_url: Option<String>,
    #[serde(default)]
    pub reachable: bool,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub ppid: Option<u32>,
    /// `None` (unknown) counts as not matching for automation.
    #[serde(default)]
    pub matches_job: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    pub bundled_version: String,
    pub unit: Unit,
    pub job: Job,
    pub instance: Instance,
    #[serde(default)]
    pub token: Option<Token>,
}

fn yes() -> bool {
    true
}

/// Parses `__desktop-connect` stdout. Errors name only serde's error category: a data error's
/// message can quote a value, and stdout carries the token.
pub fn parse_discovery(stdout: &[u8]) -> Result<Discovery, String> {
    let value: serde_json::Value = serde_json::from_slice(stdout.trim_ascii())
        .map_err(|error| format!("__desktop-connect printed invalid JSON ({:?})", error.classify()))?;
    match value.get("protocolVersion").and_then(serde_json::Value::as_u64) {
        Some(1) => {}
        other => return Err(format!("unsupported __desktop-connect protocolVersion {other:?}")),
    }
    let owner = owner(&value["unit"]);
    let mut discovery: Discovery = serde_json::from_value(value)
        .map_err(|error| format!("__desktop-connect printed an unexpected shape ({:?})", error.classify()))?;
    discovery.unit.owner = if owner == Owner::NoPlist && discovery.unit.present { Owner::Unknown } else { owner };
    Ok(discovery)
}

fn owner(unit: &serde_json::Value) -> Owner {
    match unit.get("owner") {
        Some(serde_json::Value::Null) => Owner::NoPlist,
        Some(serde_json::Value::String(owner)) if owner == "desktop" => Owner::Desktop,
        Some(serde_json::Value::String(owner)) if owner == "external" => Owner::External,
        _ => Owner::Unknown,
    }
}

#[cfg(test)]
pub(crate) mod fixture;
#[cfg(test)]
mod tests;
