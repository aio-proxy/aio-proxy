use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrayMetric {
    TodayTokens,
    TokensPerSecond,
    TodayCost,
    InFlight,
}

#[derive(Clone, PartialEq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefs {
    pub tray_metrics: Vec<TrayMetric>,
    pub tray_show_icon: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { tray_metrics: vec![], tray_show_icon: true }
    }
}

// Decode IDs separately so a preference written by a newer version can retain its known metrics.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPrefs {
    tray_metrics: Vec<String>,
    tray_show_icon: bool,
}

pub const MAX_TRAY_METRICS: usize = 2;

pub fn prefs_path(paths: &crate::install::Paths) -> PathBuf {
    paths.support.join("preferences.json")
}

impl Prefs {
    pub fn load(path: &Path) -> Prefs {
        let stored =
            fs::read(path).and_then(|bytes| serde_json::from_slice::<StoredPrefs>(&bytes).map_err(io::Error::other));
        match stored {
            Ok(stored) => {
                let mut seen = Vec::new();
                Self {
                    tray_metrics: stored
                        .tray_metrics
                        .iter()
                        .filter_map(|id| match id.as_str() {
                            "todayTokens" => Some(TrayMetric::TodayTokens),
                            "tokensPerSecond" => Some(TrayMetric::TokensPerSecond),
                            "todayCost" => Some(TrayMetric::TodayCost),
                            "inFlight" => Some(TrayMetric::InFlight),
                            _ => None,
                        })
                        .filter(|metric| {
                            if seen.contains(metric) {
                                false
                            } else {
                                seen.push(*metric);
                                true
                            }
                        })
                        .take(MAX_TRAY_METRICS)
                        .collect(),
                    tray_show_icon: stored.tray_show_icon,
                }
            }
            Err(error) => {
                crate::log::info(format!("cannot load preferences from {}: {error}; using defaults", path.display()));
                Self::default()
            }
        }
    }

    pub fn save(&self, path: &Path) -> io::Result<()> {
        let bytes = serde_json::to_vec(self).map_err(io::Error::other)?;
        let temporary = path.with_extension("json.tmp");
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, path)
    }

    pub fn toggle_metric(&mut self, metric: TrayMetric) {
        if let Some(index) = self.tray_metrics.iter().position(|selected| *selected == metric) {
            self.tray_metrics.remove(index);
        } else if self.tray_metrics.len() < MAX_TRAY_METRICS {
            self.tray_metrics.push(metric);
        }
    }

    pub fn shows_icon(&self) -> bool {
        self.tray_show_icon || self.tray_metrics.is_empty()
    }
}

#[cfg(test)]
mod tests;
