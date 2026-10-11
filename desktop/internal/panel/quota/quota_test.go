package quota

import (
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

const now int64 = 1_790_000_000

func iso(unix int64) string {
	days := unix / 86_400
	s := unix % 86_400
	if s < 0 {
		days, s = days-1, s+86_400
	}
	y, m, d := format.CivilFromDays(days)
	return fmt.Sprintf("%04d-%02d-%02dT%02d:%02d:%02d.000Z", y, m, d, s/3600, s/60%60, s%60)
}

func window(remaining *float64, leftMin *int64, length *uint32) summary.QuotaWindow {
	w := summary.QuotaWindow{
		ID:             "w",
		Label:          summary.LocalizedText{Plain: "Weekly"},
		RemainingRatio: remaining,
		WindowMinutes:  length,
	}
	if leftMin != nil {
		w.ResetsAt = iso(now + *leftMin*60)
	}
	return w
}

func provider(name string, quota summary.Quota, diagnostic string) summary.Provider {
	p := summary.Provider{
		ID:      strings.ToLower(name),
		Name:    name,
		Enabled: true,
		State:   summary.ProviderStateOK,
		Quota:   quota,
	}
	if diagnostic != "" {
		p.Diagnostic = &summary.Diagnostic{Code: "X", Summary: diagnostic}
	}
	return p
}

func ready(windows ...summary.QuotaWindow) summary.Quota {
	return summary.Quota{Kind: summary.QuotaReady, SampledAt: iso(now - 240), Windows: windows}
}

func kind(k summary.QuotaKind) summary.Quota { return summary.Quota{Kind: k} }

func names(blocks []Block) []string {
	var out []string
	for _, b := range blocks {
		out = append(out, b.Provider.Name)
	}
	return out
}

func view(t *testing.T, w summary.QuotaWindow) WindowView {
	t.Helper()
	blocks := Blocks([]summary.Provider{provider("A", ready(w), "")}, now)
	return blocks[0].Windows[0]
}

func TestAheadOfPaceReportsReserve(t *testing.T) {
	// 5 h window, 133 min left, 70% left: an even burn would leave 44%.
	p := pace(0.70, 133, 300)
	if math.Abs(p.Expected-133.0/300.0) >= 1e-9 || p.Behind {
		t.Errorf("pace = %+v", p)
	}
	if p.Note != "26% in reserve · lasts until reset" {
		t.Errorf("note = %q", p.Note)
	}
}

func TestBehindAndRunningOutReportsWhen(t *testing.T) {
	// Weekly, 5820 min left of 10080, 41% left → 17% over pace, runs out in about 2d 1h.
	p := pace(0.41, 5_820, 10_080)
	if !p.Behind || p.Note != "17% over pace · runs out in 2d 1h" {
		t.Errorf("pace = %+v", p)
	}
}

func TestExactlyOnPaceReadsZeroReserve(t *testing.T) {
	// Half the window left with half the quota left. With a constant burn, "behind pace" and
	// "runs out before reset" are the same condition (remaining < expected), so on-pace is the
	// only zero-reserve case.
	p := pace(0.5, 720, 1_440)
	if p.Behind || p.Note != "0% in reserve · lasts until reset" {
		t.Errorf("pace = %+v", p)
	}
}

func TestMissingFieldsMeanNoProjection(t *testing.T) {
	for _, w := range []summary.QuotaWindow{
		window(new(0.5), nil, new(uint32(300))),
		window(new(0.5), new(int64(60)), nil),
		window(nil, new(int64(60)), new(uint32(300))),
	} {
		if view(t, w).Pace != nil {
			t.Errorf("%+v projects", w)
		}
	}
	exhausted := view(t, window(new(0.0), new(int64(60)), new(uint32(300))))
	if !exhausted.Low {
		t.Error("exhausted is low")
	}
	p := exhausted.Pace
	if p == nil {
		t.Fatal("exhausted window with a reset and length projects")
	}
	if !p.Behind || p.Note != "20% over pace · runs out in 0m" {
		t.Errorf("pace = %+v", p)
	}
}

func TestOnlyQuotaCapableProvidersAreListedAndOrderedByAttention(t *testing.T) {
	providers := []summary.Provider{
		provider("mid", ready(window(new(0.8), new(int64(600)), new(uint32(1_440)))), ""),
		provider("Zed", ready(window(new(0.9), new(int64(600)), new(uint32(1_440)))), ""),
		provider("Over", ready(window(new(0.41), new(int64(5_820)), new(uint32(10_080)))), ""),
		provider("Low", ready(window(new(0.06), new(int64(4_560)), new(uint32(43_200)))), ""),
		provider("Broken", kind(summary.QuotaFailed), "Credentials expired"),
		provider("NoQuota", kind(summary.QuotaNone), ""),
		provider("Unsupported", kind(summary.QuotaUnsupported), ""),
		provider("Loading", kind(summary.QuotaLoading), ""),
	}
	blocks := Blocks(providers, now)
	if got := names(blocks); !slices.Equal(got, []string{"Broken", "Low", "Over", "Loading", "mid", "Zed"}) {
		t.Errorf("order = %v", got)
	}
	if AttentionCount(blocks) != 2 {
		t.Errorf("attention = %d", AttentionCount(blocks))
	}
	if blocks[0].Message != "Credentials expired" || !blocks[3].Loading {
		t.Errorf("blocks[0] %+v blocks[3] %+v", blocks[0], blocks[3])
	}
	if sampled := blocks[1].SampledAt; sampled == nil || *sampled != now-240 {
		t.Errorf("sampledAt = %v", sampled)
	}
}

func TestDurationsAndRelativeTimes(t *testing.T) {
	for minutes, want := range map[float64]string{45: "45m", 125: "2h 5m", 2_965: "2d 1h", -3: "0m", math.NaN(): "0m"} {
		if got := DurationText(minutes); got != want {
			t.Errorf("DurationText(%v) = %q, want %q", minutes, got, want)
		}
	}
	for ago, want := range map[int64]string{20: "just now", 240: "4 min ago", 3 * 3_600: "3 h ago", 2 * 86_400: "2 d ago"} {
		if got := Relative(now, now-ago); got != want {
			t.Errorf("Relative(-%d) = %q, want %q", ago, got, want)
		}
	}
}

func TestQuotaWindowEdgesAreFiniteOrAbsent(t *testing.T) {
	past := view(t, window(new(0.5), new(int64(-10)), new(uint32(300))))
	p := past.Pace
	if p == nil {
		t.Fatal("a past reset still projects")
	}
	if math.IsInf(p.Expected, 0) || math.IsNaN(p.Expected) || p.Expected != 0 {
		t.Errorf("expected = %v", p.Expected)
	}
	if strings.Contains(p.Note, "NaN") || strings.Contains(p.Note, "Inf") {
		t.Errorf("note = %q", p.Note)
	}
	if view(t, window(new(0.5), new(int64(60)), new(uint32(0)))).Pace != nil {
		t.Error("a zero-length window projects")
	}
	if r := view(t, window(new(1.4), new(int64(60)), new(uint32(300)))).Remaining; r == nil || *r != 1 {
		t.Errorf("over-full remaining = %v", r)
	}
	negative := view(t, window(new(-0.2), new(int64(60)), new(uint32(300))))
	if negative.Remaining == nil || *negative.Remaining != 0 || !negative.Low {
		t.Errorf("negative = %+v", negative)
	}
}

func TestADiagnosticOutranksAReadyQuotaAndFailedWithoutOneHasAFallbackMessage(t *testing.T) {
	providers := []summary.Provider{
		provider("Fine", ready(window(new(0.9), new(int64(600)), new(uint32(1_440)))), ""),
		provider("Flagged", ready(window(new(0.9), new(int64(600)), new(uint32(1_440)))), "Token expiring"),
		provider("Down", kind(summary.QuotaFailed), ""),
	}
	blocks := Blocks(providers, now)
	if got := names(blocks); !slices.Equal(got, []string{"Down", "Flagged", "Fine"}) {
		t.Errorf("order = %v", got)
	}
	if blocks[0].Message != "Quota unavailable" || blocks[1].Message != "Token expiring" || blocks[1].Rank != 0 {
		t.Errorf("blocks = %+v", blocks[:2])
	}
	if AttentionCount(blocks) != 2 {
		t.Errorf("attention = %d", AttentionCount(blocks))
	}
}

func TestOAuthBlocksAreTitledByServiceAndGroupedByIt(t *testing.T) {
	account := func(name, service, label string) summary.Provider {
		p := provider(name, ready(window(new(0.9), new(int64(600)), new(uint32(1_440)))), "")
		p.ID = service + "-" + name
		p.Service = &summary.LocalizedText{Plain: service}
		p.AccountLabel = label
		return p
	}
	providers := []summary.Provider{
		account("me@example.com", "xAI Grok", "me@example.com"),
		account("me@example.com", "Cursor", "me@example.com"),
		account("Work", "Cursor", ""),
		provider("Carpool", ready(window(new(0.9), new(int64(600)), new(uint32(1_440)))), ""),
	}
	var titles []string
	for _, b := range Blocks(providers, now) {
		titles = append(titles, b.Title+"|"+b.Subtitle)
	}
	want := []string{"Carpool|", "Cursor|me@example.com", "Cursor|Work", "xAI Grok|me@example.com"}
	if !slices.Equal(titles, want) {
		t.Errorf("titles = %v", titles)
	}
}

func TestPluginIconsResolveLikeTheDashboard(t *testing.T) {
	if got := IconURL("antigravity-color", true); got != "https://fastly.jsdelivr.net/npm/@lobehub/icons-static-png@latest/dark/antigravity-color.png" {
		t.Errorf("slug = %q", got)
	}
	if got := IconURL("https://example.com/a.png", false); got != "https://example.com/a.png" {
		t.Errorf("url = %q", got)
	}
	if got := IconURL("data:image/png;base64,AA==", false); got != "" {
		t.Errorf("data = %q", got)
	}
	// Not a slug: never spliced into the CDN path.
	if got := IconURL("../x", false); got != "" {
		t.Errorf("path = %q", got)
	}
}

func TestTheCollapsedTitleShowsTheTightestWindowAndAttentionOpens(t *testing.T) {
	providers := []summary.Provider{
		provider("Calm", ready(window(new(0.9), new(int64(600)), new(uint32(1_440))), window(new(0.5), nil, nil)), ""),
		provider("Low", ready(window(nil, nil, nil), window(new(0.06), new(int64(4_560)), new(uint32(43_200)))), ""),
		provider("Broken", kind(summary.QuotaFailed), ""),
	}
	blocks := Blocks(providers, now)
	var tight []string
	var open []bool
	for _, b := range blocks {
		text := b.Title + ":-"
		if w := b.Tightest(); w != nil {
			text = fmt.Sprintf("%s:%v", b.Title, *w.Remaining)
		}
		tight = append(tight, text)
		open = append(open, b.OpensByDefault())
	}
	if !slices.Equal(tight, []string{"Broken:-", "Low:0.06", "Calm:0.5"}) {
		t.Errorf("tightest = %v", tight)
	}
	if !slices.Equal(open, []bool{true, true, false}) {
		t.Errorf("open = %v", open)
	}
}
