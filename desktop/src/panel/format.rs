//! Pure display formatting: counts and money. Task 12 adds reset times and calendar days.

pub fn compact(n: u128) -> String {
    const UNITS: [(u128, &str); 4] = [(1_000_000_000_000, "T"), (1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")];
    for (scale, unit) in UNITS {
        if n >= scale {
            let tenths = n * 10 / scale;
            return if tenths >= 1_000 {
                format!("{}{unit}", tenths / 10)
            } else {
                format!("{}.{}{unit}", tenths / 10, tenths % 10)
            };
        }
    }
    n.to_string()
}

/// Nano-USD to dollars, two decimals; a non-zero amount below a cent reads `<$0.01`.
pub fn usd(nano: u128) -> String {
    let cents = nano / 10_000_000;
    if cents == 0 && nano > 0 {
        return "<$0.01".into();
    }
    format!("${}.{:02}", cents / 100, cents % 100)
}

#[cfg(test)]
mod tests;
