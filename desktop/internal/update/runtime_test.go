//go:build !darwin

package update

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInteractiveCheckReportsABadSignature(t *testing.T) {
	if Target() == "" {
		t.Skip("no update target for this OS")
	}
	oldFeed, oldOutcome := FeedURL, OnOutcome
	t.Cleanup(func() {
		FeedURL, OnOutcome = oldFeed, oldOutcome
		clearPending()
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintf(w, `{"version":"9.9.9","platforms":{%q:{"url":"https://example.com/aio-proxy-9.9.9.AppImage","signature":"!!!!"}}}`, Target())
	}))
	t.Cleanup(server.Close)
	FeedURL = server.URL
	var notes []string
	OnOutcome = func(note string, failed bool) {
		if !failed {
			t.Errorf("reported success: %s", note)
		}
		notes = append(notes, note)
	}
	check(true)
	if len(notes) != 1 || strings.Contains(notes[0], "up to date") {
		t.Fatalf("notes %q", notes)
	}
	notes = nil
	check(false)
	if len(notes) != 0 {
		t.Fatalf("a background check reported %q", notes)
	}
}
