//! The desktop token: a same-user local credential for exactly one route. It never reaches a log.

use std::fmt;

use serde::Deserialize;

#[derive(Clone, PartialEq, Eq, Deserialize)]
#[serde(transparent)]
pub struct Token(String);

impl Token {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Only the transport's `Authorization` header reads this.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Token(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::Token;

    #[test]
    fn debug_output_is_redacted() {
        let token = Token::new("s3cr3t-desktop-token");
        let printed = format!("{token:?} {:?}", Some(&token));
        assert!(!printed.contains("s3cr3t"), "{printed}");
        assert!(printed.contains("<redacted>"));
    }
}
