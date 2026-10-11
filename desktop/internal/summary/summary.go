// Package summary is `DesktopSummaryV1` (packages/types/src/desktop-summary) as the app reads it:
// `protocolVersion` first, unknown fields ignored, unknown enum values mapped to Unknown.
//
// Counts are decimal integer strings on the wire. They are unbounded; see Count.
package summary

import "sort"

type SummaryV1 struct {
	GeneratedAt string        `json:"generatedAt"`
	Server      ServerInfo    `json:"server"`
	Usage       Usage         `json:"usage"`
	Activity    []ActivityDay `json:"activity"`
	Providers   []Provider    `json:"providers"`
	Alerts      []Alert       `json:"alerts"`
}

type ServerInfo struct {
	Version string  `json:"version"`
	Pid     uint32  `json:"pid"`
	Ppid    *uint32 `json:"ppid"`
}

// UsageRange's zero value is the default range, 24h.
type UsageRange int

const (
	H24 UsageRange = iota
	D7
	D30
)

// AllUsageRanges is the segmented control's order.
var AllUsageRanges = [3]UsageRange{H24, D7, D30}

// Query is the `?range=` value; also the segmented control's label.
func (r UsageRange) Query() string {
	switch r {
	case D7:
		return "7d"
	case D30:
		return "30d"
	default:
		return "24h"
	}
}

func (r UsageRange) Label() string  { return r.Query() }
func (r UsageRange) String() string { return r.Query() }

type BucketUnit int

const (
	BucketUnitHour BucketUnit = iota
	BucketUnitDay
)

func (u BucketUnit) String() string {
	if u == BucketUnitDay {
		return "day"
	}
	return "hour"
}

type Usage struct {
	Range           UsageRange      `json:"range"`
	BucketUnit      BucketUnit      `json:"bucketUnit"`
	RangeStart      string          `json:"rangeStart"`
	RangeEnd        string          `json:"rangeEnd"`
	Current         UsageTotals     `json:"current"`
	Previous        UsageTotals     `json:"previous"`
	Buckets         []UsageBucket   `json:"buckets"`
	ByModel         []ModelUsage    `json:"byModel"`
	ByProvider      []ProviderUsage `json:"byProvider"`
	TrendByModel    []TrendCell     `json:"trendByModel"`
	TrendByProvider []TrendCell     `json:"trendByProvider"`
}

// TrendCell is one series' part of one bucket; Bucket indexes Usage.Buckets. Key is the wire's `key`,
// `modelId` or `providerId`.
type TrendCell struct {
	Bucket int
	Key    string
	Slice  UsageSlice
}

type UsageTotals struct {
	Requests             Count    `json:"requests"`
	FailedRequests       Count    `json:"failedRequests"`
	InputTokens          Count    `json:"inputTokens"`
	OutputTokens         Count    `json:"outputTokens"`
	EstimatedCostNanoUSD Count    `json:"estimatedCostNanoUsd"`
	PricingCoverage      *float64 `json:"pricingCoverage"`
}

type UsageSlice struct {
	Requests             Count `json:"requests"`
	FailedRequests       Count `json:"failedRequests"`
	TotalTokens          Count `json:"totalTokens"`
	EstimatedCostNanoUSD Count `json:"estimatedCostNanoUsd"`
}

// UsageBucket, ModelUsage and ProviderUsage carry their UsageSlice fields flattened on the wire.
type UsageBucket struct {
	Start string
	Slice UsageSlice
}

type ModelUsage struct {
	ModelID string
	Slice   UsageSlice
}

type ProviderUsage struct {
	ProviderID string
	Name       string
	Slice      UsageSlice
}

type ActivityDay struct {
	Date        string `json:"date"`
	TotalTokens Count  `json:"totalTokens"`
	// Models are the day's largest models by tokens.
	Models []ActivityModel `json:"models"`
}

type ActivityModel struct {
	ModelID     string `json:"modelId"`
	TotalTokens Count  `json:"totalTokens"`
}

type Provider struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// Service is the OAuth plugin's display name; nil for API Providers.
	Service *LocalizedText `json:"service"`
	// Icon is the plugin's icon as declared: a Lobe Icons slug, an http(s) URL or a `data:image/` URI;
	// "" when none.
	Icon    string `json:"icon"`
	Enabled bool   `json:"enabled"`
	// AccountLabel is "" when the plugin reports none.
	AccountLabel string        `json:"accountLabel"`
	State        ProviderState `json:"state"`
	Diagnostic   *Diagnostic   `json:"diagnostic"`
	Quota        Quota         `json:"quota"`
}

// Title is the service for an OAuth Provider, so accounts of different plugins under one email stay
// apart; otherwise the Provider name.
func (p *Provider) Title() string {
	if p.Service != nil {
		return p.Service.Text()
	}
	return p.Name
}

// Subtitle is the account, or the Provider name when the plugin reports none; ok is false when there
// is neither or it repeats the title.
func (p *Provider) Subtitle() (string, bool) {
	subtitle := p.AccountLabel
	if subtitle == "" {
		if p.Service == nil {
			return "", false
		}
		subtitle = p.Name
	}
	if subtitle == p.Title() {
		return "", false
	}
	return subtitle, true
}

type ProviderState int

const (
	ProviderStateUnknown ProviderState = iota
	ProviderStateOK
	ProviderStateDegraded
	ProviderStateUnavailable
	ProviderStateDisabled
)

func (s ProviderState) String() string {
	switch s {
	case ProviderStateOK:
		return "ok"
	case ProviderStateDegraded:
		return "degraded"
	case ProviderStateUnavailable:
		return "unavailable"
	case ProviderStateDisabled:
		return "disabled"
	default:
		return "unknown"
	}
}

type Diagnostic struct {
	Code    string `json:"code"`
	Summary string `json:"summary"`
	// SuggestedCommand is "" when there is none.
	SuggestedCommand string `json:"suggestedCommand"`
}

// QuotaKind is the wire's `status`.
type QuotaKind int

const (
	QuotaUnknown QuotaKind = iota
	QuotaNone
	QuotaUnsupported
	QuotaLoading
	QuotaFailed
	QuotaReady
)

func (k QuotaKind) String() string {
	switch k {
	case QuotaNone:
		return "none"
	case QuotaUnsupported:
		return "unsupported"
	case QuotaLoading:
		return "loading"
	case QuotaFailed:
		return "failed"
	case QuotaReady:
		return "ready"
	default:
		return "unknown"
	}
}

// Quota's other fields are set only when Kind is QuotaReady.
type Quota struct {
	Kind          QuotaKind
	SampledAt     string
	RefreshFailed bool
	Plan          *LocalizedText
	Windows       []QuotaWindow
}

type QuotaWindow struct {
	ID             string        `json:"id"`
	Label          LocalizedText `json:"label"`
	RemainingRatio *float64      `json:"remainingRatio"`
	// ResetsAt is "" when unknown.
	ResetsAt      string  `json:"resetsAt"`
	WindowMinutes *uint32 `json:"windowMinutes"`
}

// LocalizedText is either plain text or a map of language tags that always carries `default`.
// Localized is nil for plain text.
type LocalizedText struct {
	Plain     string
	Localized map[string]string
}

// Text is the `default` entry: the panel is English-only.
func (t LocalizedText) Text() string {
	if t.Localized == nil {
		return t.Plain
	}
	if text, ok := t.Localized["default"]; ok {
		return text
	}
	// Otherwise the first entry in key order, as the Rust BTreeMap did.
	keys := make([]string, 0, len(t.Localized))
	for key := range t.Localized {
		keys = append(keys, key)
	}
	if len(keys) == 0 {
		return ""
	}
	sort.Strings(keys)
	return t.Localized[keys[0]]
}

type Alert struct {
	ProviderID string    `json:"providerId"`
	Kind       AlertKind `json:"kind"`
	Message    string    `json:"message"`
}

type AlertKind int

const (
	AlertKindUnknown AlertKind = iota
	AlertKindDiagnostic
	AlertKindQuotaExhausted
)

func (k AlertKind) String() string {
	switch k {
	case AlertKindDiagnostic:
		return "diagnostic"
	case AlertKindQuotaExhausted:
		return "quota_exhausted"
	default:
		return "unknown"
	}
}

// AnyQuotaLoading drives the refresh policy's one shared refetch after 2 s.
func (s *SummaryV1) AnyQuotaLoading() bool {
	for i := range s.Providers {
		if s.Providers[i].Quota.Kind == QuotaLoading {
			return true
		}
	}
	return false
}
