package summary

import (
	"encoding/json"
	"os"
	"testing"
)

// The TS package's golden fixture, the same input the TS tests check.
const goldenPath = "../../../packages/types/src/desktop-summary/fixtures/v1.json"

func golden(t *testing.T) []byte {
	t.Helper()
	body, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// mutated is the golden fixture after edit changes its decoded JSON.
func mutated(t *testing.T, edit func(root map[string]any)) []byte {
	t.Helper()
	var root map[string]any
	if err := json.Unmarshal(golden(t), &root); err != nil {
		t.Fatal(err)
	}
	edit(root)
	body, err := json.Marshal(root)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// at walks objects by key and arrays by index.
func at(v any, path ...any) map[string]any {
	for _, step := range path {
		switch step := step.(type) {
		case string:
			v = v.(map[string]any)[step]
		case int:
			v = v.([]any)[step]
		}
	}
	return v.(map[string]any)
}

func v1(t *testing.T, body []byte) *SummaryV1 {
	t.Helper()
	parsed := Parse(body)
	if parsed.Kind != ParsedV1 {
		t.Fatalf("expected v1, got %+v", parsed)
	}
	return parsed.V1
}

func TestTheGoldenFixtureParses(t *testing.T) {
	summary := v1(t, golden(t))
	if summary.Server.Version != "0.36.0" {
		t.Errorf("server.version = %q", summary.Server.Version)
	}
	if summary.Server.Ppid == nil || *summary.Server.Ppid != 4310 {
		t.Errorf("server.ppid = %v", summary.Server.Ppid)
	}
	usage := &summary.Usage
	if usage.Range != D7 || usage.BucketUnit != BucketUnitDay {
		t.Errorf("range/bucketUnit = %v/%v", usage.Range, usage.BucketUnit)
	}
	if usage.Current.Requests != 257 || usage.Current.EstimatedCostNanoUSD != 20_521_353_840 {
		t.Errorf("current = %+v", usage.Current)
	}
	if usage.Previous.PricingCoverage == nil || *usage.Previous.PricingCoverage != 0.5 {
		t.Errorf("previous.pricingCoverage = %v", usage.Previous.PricingCoverage)
	}
	if usage.Buckets[0].Slice.FailedRequests != 53 {
		t.Errorf("buckets[0] = %+v", usage.Buckets[0])
	}
	if usage.ByModel[0].ModelID != "gpt-5.2-codex" || usage.ByProvider[0].Name != "Codex" {
		t.Errorf("byModel/byProvider = %+v / %+v", usage.ByModel[0], usage.ByProvider[0])
	}
	if cell := usage.TrendByModel[0]; cell.Bucket != 0 || cell.Key != "gpt-5.2-codex" || cell.Slice.TotalTokens != 14_859_707 {
		t.Errorf("trendByModel[0] = %+v", cell)
	}
	if cell := usage.TrendByProvider[0]; cell.Key != "codex" {
		t.Errorf("trendByProvider[0] = %+v", cell)
	}
	if summary.Activity[0].Date != "2026-09-29" {
		t.Errorf("activity[0].date = %q", summary.Activity[0].Date)
	}
	codex := &summary.Providers[0]
	if codex.State != ProviderStateOK || codex.AccountLabel != "you@example.com" {
		t.Errorf("codex = %+v", codex)
	}
	if codex.Quota.Kind != QuotaReady {
		t.Fatalf("codex quota should be ready, got %v", codex.Quota.Kind)
	}
	if codex.Quota.RefreshFailed {
		t.Error("refreshFailed")
	}
	if codex.Quota.Plan == nil || codex.Quota.Plan.Text() != "Pro" {
		t.Errorf("plan = %+v", codex.Quota.Plan)
	}
	window := codex.Quota.Windows[0]
	if window.Label.Text() != "5 hours" || window.RemainingRatio == nil || *window.RemainingRatio != 0.4 {
		t.Errorf("window = %+v", window)
	}
	cursor := &summary.Providers[1]
	if cursor.AccountLabel != "" {
		t.Errorf("cursor accountLabel = %q", cursor.AccountLabel)
	}
	if cursor.Diagnostic == nil || cursor.Diagnostic.SuggestedCommand != "aio-proxy provider login --provider cursor" {
		t.Errorf("cursor diagnostic = %+v", cursor.Diagnostic)
	}
	if cursor.Quota.Kind != QuotaLoading {
		t.Errorf("cursor quota = %v", cursor.Quota.Kind)
	}
	if summary.Alerts[0].Kind != AlertKindDiagnostic {
		t.Errorf("alerts[0].kind = %v", summary.Alerts[0].Kind)
	}
	if !summary.AnyQuotaLoading() {
		t.Error("AnyQuotaLoading should be true")
	}
}

func TestAnUnknownUsageRangeIsAnInvalidSummary(t *testing.T) {
	body := mutated(t, func(root map[string]any) { at(root, "usage")["range"] = "90d" })
	if parsed := Parse(body); parsed.Kind != ParsedInvalid {
		t.Fatalf("got %+v", parsed)
	}
}

func TestRangeQueryValuesMatchTheServer(t *testing.T) {
	var got [3]string
	for i, r := range AllUsageRanges {
		got[i] = r.Query()
	}
	if got != [3]string{"24h", "7d", "30d"} {
		t.Fatalf("got %v", got)
	}
	var zero UsageRange
	if zero != H24 {
		t.Fatal("the default range must be 24h")
	}
}

func TestUnknownFieldsAreIgnoredEverywhere(t *testing.T) {
	body := mutated(t, func(root map[string]any) {
		root["futureTopLevel"] = map[string]any{"x": 1}
		at(root, "server")["startedAt"] = "2026-09-29T00:00:00Z"
		at(root, "providers", 0, "quota", "windows", 0)["futureField"] = true
		at(root, "providers", 1, "quota")["hint"] = "warming"
	})
	if summary := v1(t, body); summary.Providers[1].Quota.Kind != QuotaLoading {
		t.Fatalf("got %v", summary.Providers[1].Quota.Kind)
	}
}

func TestUnknownEnumValuesMapToUnknown(t *testing.T) {
	body := mutated(t, func(root map[string]any) {
		at(root, "providers", 0)["state"] = "rate_limited"
		at(root, "providers", 1)["quota"] = map[string]any{"status": "throttled", "retryAt": "soon"}
		at(root, "alerts", 0)["kind"] = "budget_warning"
	})
	summary := v1(t, body)
	if summary.Providers[0].State != ProviderStateUnknown {
		t.Errorf("state = %v", summary.Providers[0].State)
	}
	if summary.Providers[1].Quota.Kind != QuotaUnknown {
		t.Errorf("quota = %v", summary.Providers[1].Quota.Kind)
	}
	if summary.Alerts[0].Kind != AlertKindUnknown {
		t.Errorf("alert kind = %v", summary.Alerts[0].Kind)
	}
}

func TestAnUnsupportedProtocolVersionSelectsTheDegradedPanel(t *testing.T) {
	got := Classify(200, []byte(`{ "protocolVersion": 2, "usage": "a shape v1 cannot read" }`))
	want := DegradedReason{Kind: DegradedUnsupportedVersion, Version: 2, HasVersion: true}
	if got.Kind != OutcomeDegraded || got.Degraded != want {
		t.Errorf("got %+v", got)
	}
	got = Classify(200, []byte(`{ "status": "ok" }`))
	if got.Kind != OutcomeDegraded || got.Degraded != (DegradedReason{Kind: DegradedUnsupportedVersion}) {
		t.Errorf("got %+v", got)
	}
}

func TestAMissingRouteSelectsTheDegradedPanel(t *testing.T) {
	got := Classify(404, []byte("Not Found"))
	if got.Kind != OutcomeDegraded || got.Degraded != (DegradedReason{Kind: DegradedMissing}) {
		t.Fatalf("got %+v", got)
	}
}

func TestUnauthorizedAndServerErrorsAreDistinctOutcomes(t *testing.T) {
	if got := Classify(401, []byte(`{"error":"unauthorized"}`)); got.Kind != OutcomeUnauthorized {
		t.Errorf("401: %+v", got)
	}
	if got := Classify(500, nil); got.Kind != OutcomeFailed || got.Err != "desktop summary answered HTTP 500" {
		t.Errorf("500: %+v", got)
	}
	if got := Classify(200, []byte("<html>")); got.Kind != OutcomeFailed {
		t.Errorf("html: %+v", got)
	}
}

func TestACountBeyond2Pow53Survives(t *testing.T) {
	body := mutated(t, func(root map[string]any) {
		at(root, "usage", "current")["inputTokens"] = "18014398509481985"
	})
	if got := v1(t, body).Usage.Current.InputTokens; got != 18_014_398_509_481_985 {
		t.Fatalf("got %d", got)
	}
}

// The serde rules encoding/json does not apply by itself.
func TestMissingNullAndMistypedFieldsAreInvalid(t *testing.T) {
	cases := map[string]func(root map[string]any){
		"missing generatedAt":    func(root map[string]any) { delete(root, "generatedAt") },
		"null server":            func(root map[string]any) { root["server"] = nil },
		"null providers":         func(root map[string]any) { root["providers"] = nil },
		"missing quota":          func(root map[string]any) { delete(at(root, "providers", 0), "quota") },
		"missing quota status":   func(root map[string]any) { delete(at(root, "providers", 0, "quota"), "status") },
		"ready without windows":  func(root map[string]any) { delete(at(root, "providers", 0, "quota"), "windows") },
		"numeric count":          func(root map[string]any) { at(root, "usage", "current")["requests"] = 257 },
		"unknown bucket unit":    func(root map[string]any) { at(root, "usage")["bucketUnit"] = "week" },
		"null trend key":         func(root map[string]any) { at(root, "usage", "trendByModel", 0)["modelId"] = nil },
		"numeric label":          func(root map[string]any) { at(root, "providers", 0, "quota", "windows", 0)["label"] = 5 },
		"missing slice field":    func(root map[string]any) { delete(at(root, "usage", "buckets", 0), "totalTokens") },
		"negative trend bucket":  func(root map[string]any) { at(root, "usage", "trendByModel", 0)["bucket"] = -1 },
		"numeric provider state": func(root map[string]any) { at(root, "providers", 0)["state"] = 1 },
	}
	for name, edit := range cases {
		if parsed := Parse(mutated(t, edit)); parsed.Kind != ParsedInvalid {
			t.Errorf("%s: got %+v", name, parsed)
		}
	}
}

func TestOptionalFieldsMayBeMissingOrNull(t *testing.T) {
	body := mutated(t, func(root map[string]any) {
		delete(root, "activity")
		delete(at(root, "server"), "ppid")
		at(root, "usage", "current")["pricingCoverage"] = nil
		delete(at(root, "providers", 0), "accountLabel")
		delete(at(root, "providers", 0), "diagnostic")
	})
	summary := v1(t, body)
	if summary.Activity != nil || summary.Server.Ppid != nil || summary.Usage.Current.PricingCoverage != nil {
		t.Fatalf("got %+v", summary)
	}
}

func TestLocalizedTextPrefersDefault(t *testing.T) {
	if got := (LocalizedText{Localized: map[string]string{"zh-Hans": "z", "default": "d"}}).Text(); got != "d" {
		t.Errorf("got %q", got)
	}
	if got := (LocalizedText{Localized: map[string]string{"zh-Hans": "z", "en": "e"}}).Text(); got != "e" {
		t.Errorf("first key in order: got %q", got)
	}
	if got := (LocalizedText{Localized: map[string]string{}}).Text(); got != "" {
		t.Errorf("empty: got %q", got)
	}
}

func TestProviderTitleAndSubtitle(t *testing.T) {
	service := &LocalizedText{Plain: "Cursor"}
	cases := []struct {
		provider Provider
		title    string
		subtitle string
		ok       bool
	}{
		{Provider{Name: "cursor", Service: service, AccountLabel: "me@x"}, "Cursor", "me@x", true},
		{Provider{Name: "cursor", Service: service}, "Cursor", "cursor", true},
		{Provider{Name: "Cursor", Service: service}, "Cursor", "", false},
		{Provider{Name: "OpenRouter"}, "OpenRouter", "", false},
		{Provider{Name: "OpenRouter", AccountLabel: "OpenRouter"}, "OpenRouter", "", false},
	}
	for _, c := range cases {
		subtitle, ok := c.provider.Subtitle()
		if c.provider.Title() != c.title || subtitle != c.subtitle || ok != c.ok {
			t.Errorf("%+v: title %q subtitle %q %v", c.provider, c.provider.Title(), subtitle, ok)
		}
	}
}
