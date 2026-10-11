package panel

import (
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/quota"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
	"github.com/egoist/mygo/ui"
)

func TestQuotaDisclosureKeyboardFreezesCurrentPicks(t *testing.T) {
	v := viewState{QuotaOpen: make(map[string]bool)}
	blocks := []quota.Block{
		{Provider: &summary.Provider{ID: "a"}, Title: "Provider A", Rank: 3, Command: "A details"},
		{Provider: &summary.Provider{ID: "b"}, Title: "Provider B", Rank: 0, Command: "B details"},
	}
	tt := ui.NewTester(func(c *ui.Context) {
		ui.Column(c).FillWidth().Children(func() { quotaGroup(c, nil, &v, blocks, 1_000) })
	}, 360, 600)
	tt.SetPreferences(ui.Preferences{ReduceMotion: true, TextScale: 1})
	if tt.HasText("A details") || !tt.HasText("B details") || len(v.QuotaOpen) != 0 {
		t.Fatal("initial disclosures did not follow attention without touching their picks")
	}

	blocks[0].Rank, blocks[1].Rank = 0, 3
	tt.Frame()
	if !tt.HasText("A details") || tt.HasText("B details") || len(v.QuotaOpen) != 0 {
		t.Fatal("untouched disclosures did not follow the changed attention state")
	}
	blocks[0].Rank, blocks[1].Rank = 3, 0
	tt.Frame()

	tt.Key(0, ui.KeyTab)
	tt.Key(0, ui.KeyEnter)
	if !v.QuotaOpen["a"] || !v.QuotaOpen["b"] || !tt.HasText("A details") || !tt.HasText("B details") {
		t.Fatal("Enter did not open A while retaining B's current pick")
	}
	tt.Key(0, ui.KeySpace)
	if v.QuotaOpen["a"] || !v.QuotaOpen["b"] || tt.HasText("A details") || !tt.HasText("B details") {
		t.Fatal("Space did not close only the focused disclosure")
	}

	// Attention changes and a provider reorder must not reset manual picks or
	// move keyboard focus to the provider now occupying the old position.
	blocks[0].Rank, blocks[1].Rank = 0, 3
	blocks[0], blocks[1] = blocks[1], blocks[0]
	tt.Frame()
	if tt.HasText("A details") || !tt.HasText("B details") {
		t.Fatal("manual picks followed attention or position instead of provider identity")
	}
	tt.Key(0, ui.KeyEnter)
	if !v.QuotaOpen["a"] || !v.QuotaOpen["b"] || !tt.HasText("A details") || !tt.HasText("B details") {
		t.Fatal("keyboard focus did not stay on A after the provider reorder")
	}
}
