package degraded

import (
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

func TestBodyExplainsEachDegradedReason(t *testing.T) {
	for _, test := range []struct {
		name   string
		reason summary.DegradedReason
		want   string
	}{
		{"missing summary", summary.DegradedReason{Kind: summary.DegradedMissing}, "This aio-proxy is older than the desktop app and has no summary. Update it to see usage."},
		{"new protocol", summary.DegradedReason{Kind: summary.DegradedUnsupportedVersion, Version: 2, HasVersion: true}, "This aio-proxy speaks a newer summary format. Update the desktop app to see usage."},
		{"unrecognized protocol", summary.DegradedReason{Kind: summary.DegradedUnsupportedVersion}, "This aio-proxy speaks a newer summary format. Update the desktop app to see usage."},
		{"missing token", summary.DegradedReason{Kind: summary.DegradedNoToken}, "Usage cannot be shown: this aio-proxy has no desktop token, or the port belongs to another user's process. Update aio-proxy, or check what listens on its port."},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := Body(test.reason); got != test.want {
				t.Errorf("Body(%+v) = %q, want %q", test.reason, got, test.want)
			}
		})
	}
}
