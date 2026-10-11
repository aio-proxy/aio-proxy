package summary

import (
	"encoding/json"
	"fmt"
	"strconv"
)

type ParsedKind int

const (
	ParsedV1 ParsedKind = iota
	// ParsedUnsupported is a `protocolVersion` this app does not know (or none at all): degraded panel.
	ParsedUnsupported
	ParsedInvalid
)

// Parsed: V1 is set for ParsedV1; Version/HasVersion for ParsedUnsupported; Err for ParsedInvalid.
type Parsed struct {
	Kind       ParsedKind
	V1         *SummaryV1
	Version    uint64
	HasVersion bool
	Err        string
}

// Parse reads `protocolVersion` before anything else, so a future body shape never reaches the v1 parser.
func Parse(body []byte) Parsed {
	var probe struct {
		ProtocolVersion json.RawMessage `json:"protocolVersion"`
	}
	if err := json.Unmarshal(body, &probe); err != nil {
		return Parsed{Kind: ParsedInvalid, Err: err.Error()}
	}
	// Only a non-negative integer literal counts as a version; 1.0, "1" and null are none.
	version, err := strconv.ParseUint(string(probe.ProtocolVersion), 10, 64)
	if err != nil {
		return Parsed{Kind: ParsedUnsupported}
	}
	if version != 1 {
		return Parsed{Kind: ParsedUnsupported, Version: version, HasVersion: true}
	}
	var summary SummaryV1
	if err := json.Unmarshal(body, &summary); err != nil {
		return Parsed{Kind: ParsedInvalid, Err: err.Error()}
	}
	return Parsed{Kind: ParsedV1, V1: &summary}
}

type DegradedKind int

const (
	// DegradedMissing is a 404: an instance older than `desktop-summary`.
	DegradedMissing DegradedKind = iota
	DegradedUnsupportedVersion
	// DegradedNoToken: discovery found no desktop token (an older proxy that never writes one, or a
	// file failing its checks), so no summary request is sent.
	DegradedNoToken
)

// DegradedReason is comparable with ==. Version/HasVersion are set only for DegradedUnsupportedVersion.
type DegradedReason struct {
	Kind       DegradedKind
	Version    uint64
	HasVersion bool
}

type OutcomeKind int

const (
	OutcomeSummary OutcomeKind = iota
	OutcomeDegraded
	// OutcomeUnauthorized is a 401: re-run discovery once to pick up a replaced token, then report
	// "authentication failed".
	OutcomeUnauthorized
	OutcomeFailed
)

// FetchOutcome: Summary is set for OutcomeSummary, Degraded for OutcomeDegraded, Err for OutcomeFailed.
type FetchOutcome struct {
	Kind     OutcomeKind
	Summary  *SummaryV1
	Degraded DegradedReason
	Err      string
}

// Classify maps one `GET /dashboard/api/desktop-summary` response to what the panel shows.
func Classify(status int, body []byte) FetchOutcome {
	switch status {
	case 200:
		parsed := Parse(body)
		switch parsed.Kind {
		case ParsedV1:
			return FetchOutcome{Kind: OutcomeSummary, Summary: parsed.V1}
		case ParsedUnsupported:
			return FetchOutcome{Kind: OutcomeDegraded, Degraded: DegradedReason{
				Kind: DegradedUnsupportedVersion, Version: parsed.Version, HasVersion: parsed.HasVersion,
			}}
		default:
			return FetchOutcome{Kind: OutcomeFailed, Err: "invalid desktop summary: " + parsed.Err}
		}
	case 401:
		return FetchOutcome{Kind: OutcomeUnauthorized}
	case 404:
		return FetchOutcome{Kind: OutcomeDegraded, Degraded: DegradedReason{Kind: DegradedMissing}}
	default:
		return FetchOutcome{Kind: OutcomeFailed, Err: fmt.Sprintf("desktop summary answered HTTP %d", status)}
	}
}
