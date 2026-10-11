// Package update decides and verifies Linux and Windows updates. macOS keeps Sparkle.
package update

import (
	"fmt"
	"path/filepath"

	"github.com/aio-proxy/aio-proxy/desktop/internal/version"
)

type CheckOutcome int

const (
	CheckSilent CheckOutcome = iota
	CheckUpToDate
	CheckAvailable
)

// Decide is silent on a background miss and explicit when the user asked.
func Decide(current string, offered string, hasOffer, interactive bool) (CheckOutcome, string) {
	if hasOffer {
		if cmp, ok := version.Compare(offered, current); ok && cmp > 0 {
			return CheckAvailable, offered
		}
	}
	if interactive {
		return CheckUpToDate, ""
	}
	return CheckSilent, ""
}

type InstallAction int

const (
	InstallInPlace InstallAction = iota
	InstallOpenURL
)

// InstallPlan replaces an AppImage in place only when its directory is writable.
func InstallPlan(appimage string, dirWritable func(string) bool, version string) (InstallAction, string) {
	if appimage != "" {
		dir := filepath.Dir(appimage)
		if dir != "" && dir != "." && dirWritable(dir) {
			return InstallInPlace, ""
		}
	}
	return InstallOpenURL, "https://github.com/aio-proxy/aio-proxy/releases/tag/v" + version
}

func ReleasePage(version string) string {
	return fmt.Sprintf("https://github.com/aio-proxy/aio-proxy/releases/tag/v%s", version)
}
