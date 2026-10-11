// Package token holds the desktop token: a same-user local credential for exactly one route. It never
// reaches a log.
package token

import "encoding/json"

// Token prints as <redacted> through fmt and encoding/json; only the transport's Authorization
// header reads Expose.
type Token struct{ value string }

func New(value string) Token { return Token{value: value} }

func (t Token) Expose() string { return t.value }

func (Token) String() string   { return "Token(<redacted>)" }
func (Token) GoString() string { return "Token(<redacted>)" }

func (t *Token) UnmarshalJSON(data []byte) error { return json.Unmarshal(data, &t.value) }

func (Token) MarshalJSON() ([]byte, error) { return []byte(`"<redacted>"`), nil }
