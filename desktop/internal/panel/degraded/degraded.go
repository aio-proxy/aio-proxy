// Package degraded supplies the panel's explanation when desktop-summary is
// unavailable. The view adds status, endpoint, Open Dashboard and Reload.
package degraded

import "github.com/aio-proxy/aio-proxy/desktop/internal/summary"

// Body explains which side needs updating, or why a desktop token is required.
func Body(reason summary.DegradedReason) string {
	switch reason.Kind {
	case summary.DegradedMissing:
		return "This aio-proxy is older than the desktop app and has no summary. Update it to see usage."
	case summary.DegradedUnsupportedVersion:
		return "This aio-proxy speaks a newer summary format. Update the desktop app to see usage."
	case summary.DegradedNoToken:
		return "Usage cannot be shown: this aio-proxy has no desktop token, or the port belongs to another user's process. Update aio-proxy, or check what listens on its port."
	default:
		panic("invalid degraded summary reason")
	}
}
