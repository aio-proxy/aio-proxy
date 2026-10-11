package summary

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
)

// encoding/json zeroes a missing or null field silently, where the Rust serde types rejected both for
// non-optional fields and rejected null for defaulted lists. Each UnmarshalJSON first checks keys with
// checkObject, then decodes through a method-less copy of the type so nested decoders still run.

func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

func checkObject(data []byte, required, defaulted []string) (map[string]json.RawMessage, error) {
	if isNull(data) {
		return nil, errors.New("invalid type: null, expected an object")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return nil, err
	}
	for _, key := range required {
		raw, ok := fields[key]
		if !ok {
			return nil, fmt.Errorf("missing field `%s`", key)
		}
		if isNull(raw) {
			return nil, fmt.Errorf("invalid type: null for field `%s`", key)
		}
	}
	for _, key := range defaulted {
		if raw, ok := fields[key]; ok && isNull(raw) {
			return nil, fmt.Errorf("invalid type: null for field `%s`", key)
		}
	}
	return fields, nil
}

// decodeString rejects null and non-strings, unlike json.Unmarshal into a string.
func decodeString(data []byte) (string, error) {
	if isNull(data) {
		return "", errors.New("invalid type: null, expected a string")
	}
	var s string
	err := json.Unmarshal(data, &s)
	return s, err
}

func (s *SummaryV1) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"generatedAt", "server", "usage"}, []string{"activity", "providers", "alerts"}); err != nil {
		return err
	}
	type plain SummaryV1
	return json.Unmarshal(data, (*plain)(s))
}

func (s *ServerInfo) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"version", "pid"}, nil); err != nil {
		return err
	}
	type plain ServerInfo
	return json.Unmarshal(data, (*plain)(s))
}

func (r *UsageRange) UnmarshalJSON(data []byte) error {
	text, err := decodeString(data)
	if err != nil {
		return err
	}
	switch text {
	case "24h":
		*r = H24
	case "7d":
		*r = D7
	case "30d":
		*r = D30
	default:
		return fmt.Errorf("unknown usage range %q", text)
	}
	return nil
}

func (u *BucketUnit) UnmarshalJSON(data []byte) error {
	text, err := decodeString(data)
	if err != nil {
		return err
	}
	switch text {
	case "hour":
		*u = BucketUnitHour
	case "day":
		*u = BucketUnitDay
	default:
		return fmt.Errorf("unknown bucket unit %q", text)
	}
	return nil
}

func (u *Usage) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data,
		[]string{"range", "bucketUnit", "rangeStart", "rangeEnd", "current", "previous"},
		[]string{"buckets", "byModel", "byProvider", "trendByModel", "trendByProvider"},
	); err != nil {
		return err
	}
	type plain Usage
	return json.Unmarshal(data, (*plain)(u))
}

func (t *UsageTotals) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"requests", "failedRequests", "inputTokens", "outputTokens", "estimatedCostNanoUsd"}, nil); err != nil {
		return err
	}
	type plain UsageTotals
	return json.Unmarshal(data, (*plain)(t))
}

func (s *UsageSlice) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"requests", "failedRequests", "totalTokens", "estimatedCostNanoUsd"}, nil); err != nil {
		return err
	}
	type plain UsageSlice
	return json.Unmarshal(data, (*plain)(s))
}

func (t *TrendCell) UnmarshalJSON(data []byte) error {
	fields, err := checkObject(data, []string{"bucket"}, nil)
	if err != nil {
		return err
	}
	// `modelId` and `providerId` are aliases of `key`; more than one is a duplicate field.
	var keyRaw json.RawMessage
	for _, name := range []string{"key", "modelId", "providerId"} {
		if raw, ok := fields[name]; ok {
			if keyRaw != nil {
				return errors.New("duplicate field `key`")
			}
			keyRaw = raw
		}
	}
	if keyRaw == nil {
		return errors.New("missing field `key`")
	}
	if t.Key, err = decodeString(keyRaw); err != nil {
		return err
	}
	var bucket uint64
	if err := json.Unmarshal(fields["bucket"], &bucket); err != nil {
		return err
	}
	if bucket > math.MaxInt {
		return fmt.Errorf("bucket index %d out of range", bucket)
	}
	t.Bucket = int(bucket)
	return t.Slice.UnmarshalJSON(data)
}

func (b *UsageBucket) UnmarshalJSON(data []byte) error {
	var wire struct {
		Start string `json:"start"`
	}
	if err := decodeFlattened(data, []string{"start"}, &wire, &b.Slice); err != nil {
		return err
	}
	b.Start = wire.Start
	return nil
}

func (m *ModelUsage) UnmarshalJSON(data []byte) error {
	var wire struct {
		ModelID string `json:"modelId"`
	}
	if err := decodeFlattened(data, []string{"modelId"}, &wire, &m.Slice); err != nil {
		return err
	}
	m.ModelID = wire.ModelID
	return nil
}

func (p *ProviderUsage) UnmarshalJSON(data []byte) error {
	var wire struct {
		ProviderID string `json:"providerId"`
		Name       string `json:"name"`
	}
	if err := decodeFlattened(data, []string{"providerId", "name"}, &wire, &p.Slice); err != nil {
		return err
	}
	p.ProviderID, p.Name = wire.ProviderID, wire.Name
	return nil
}

// decodeFlattened decodes an object carrying its own required fields plus a flattened UsageSlice.
func decodeFlattened(data []byte, required []string, wire any, slice *UsageSlice) error {
	if _, err := checkObject(data, required, nil); err != nil {
		return err
	}
	if err := json.Unmarshal(data, wire); err != nil {
		return err
	}
	return slice.UnmarshalJSON(data)
}

func (d *ActivityDay) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"date", "totalTokens"}, []string{"models"}); err != nil {
		return err
	}
	type plain ActivityDay
	return json.Unmarshal(data, (*plain)(d))
}

func (m *ActivityModel) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"modelId", "totalTokens"}, nil); err != nil {
		return err
	}
	type plain ActivityModel
	return json.Unmarshal(data, (*plain)(m))
}

func (p *Provider) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"id", "name", "enabled", "state", "quota"}, nil); err != nil {
		return err
	}
	type plain Provider
	return json.Unmarshal(data, (*plain)(p))
}

func (s *ProviderState) UnmarshalJSON(data []byte) error {
	text, err := decodeString(data)
	if err != nil {
		return err
	}
	switch text {
	case "ok":
		*s = ProviderStateOK
	case "degraded":
		*s = ProviderStateDegraded
	case "unavailable":
		*s = ProviderStateUnavailable
	case "disabled":
		*s = ProviderStateDisabled
	default:
		*s = ProviderStateUnknown
	}
	return nil
}

func (d *Diagnostic) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"code", "summary"}, nil); err != nil {
		return err
	}
	type plain Diagnostic
	return json.Unmarshal(data, (*plain)(d))
}

// UnmarshalJSON reads the `status` tag; other fields matter only for `ready`, and an unknown status
// is QuotaUnknown.
func (q *Quota) UnmarshalJSON(data []byte) error {
	fields, err := checkObject(data, []string{"status"}, nil)
	if err != nil {
		return err
	}
	status, err := decodeString(fields["status"])
	if err != nil {
		return err
	}
	*q = Quota{}
	switch status {
	case "none":
		q.Kind = QuotaNone
	case "unsupported":
		q.Kind = QuotaUnsupported
	case "loading":
		q.Kind = QuotaLoading
	case "failed":
		q.Kind = QuotaFailed
	case "ready":
		if _, err := checkObject(data, []string{"sampledAt", "refreshFailed", "windows"}, nil); err != nil {
			return err
		}
		var ready struct {
			SampledAt     string         `json:"sampledAt"`
			RefreshFailed bool           `json:"refreshFailed"`
			Plan          *LocalizedText `json:"plan"`
			Windows       []QuotaWindow  `json:"windows"`
		}
		if err := json.Unmarshal(data, &ready); err != nil {
			return err
		}
		*q = Quota{Kind: QuotaReady, SampledAt: ready.SampledAt, RefreshFailed: ready.RefreshFailed, Plan: ready.Plan, Windows: ready.Windows}
	default:
		q.Kind = QuotaUnknown
	}
	return nil
}

func (w *QuotaWindow) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"id", "label"}, nil); err != nil {
		return err
	}
	type plain QuotaWindow
	return json.Unmarshal(data, (*plain)(w))
}

// UnmarshalJSON accepts a string or an object of strings, nothing else.
func (t *LocalizedText) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 {
		switch trimmed[0] {
		case '"':
			*t = LocalizedText{}
			return json.Unmarshal(trimmed, &t.Plain)
		case '{':
			localized := map[string]string{}
			if err := json.Unmarshal(trimmed, &localized); err != nil {
				return err
			}
			*t = LocalizedText{Localized: localized}
			return nil
		}
	}
	return errors.New("data did not match any variant of LocalizedText")
}

func (a *Alert) UnmarshalJSON(data []byte) error {
	if _, err := checkObject(data, []string{"providerId", "kind", "message"}, nil); err != nil {
		return err
	}
	type plain Alert
	return json.Unmarshal(data, (*plain)(a))
}

func (k *AlertKind) UnmarshalJSON(data []byte) error {
	text, err := decodeString(data)
	if err != nil {
		return err
	}
	switch text {
	case "diagnostic":
		*k = AlertKindDiagnostic
	case "quota_exhausted":
		*k = AlertKindQuotaExhausted
	default:
		*k = AlertKindUnknown
	}
	return nil
}
