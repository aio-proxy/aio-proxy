package panel

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestSegmentedMouseAndKeyboardCommitSelection(t *testing.T) {
	selected := 0
	committed := -1
	tt := ui.NewTester(func(c *ui.Context) {
		segmented(c, &selected, "Usage range", "24h", "7d", "30d").OnChange(func() { committed = selected })
	}, 200, 40)
	tt.SetPreferences(ui.Preferences{ReduceMotion: true})
	if err := tt.Click("7d"); err != nil {
		t.Fatal(err)
	}
	if selected != 1 || committed != 1 {
		t.Fatal("mouse selection did not commit")
	}
	tt.Key(0, ui.KeyRight)
	if selected != 2 || committed != 2 {
		t.Fatal("focused arrow key did not choose next segment")
	}
	tt.Key(0, ui.KeyLeft)
	if selected != 1 || committed != 1 {
		t.Fatal("focused arrow key did not choose previous segment")
	}
}
