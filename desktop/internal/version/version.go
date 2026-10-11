// Package version holds aio-proxy's version rules: semver precedence, never string order
// ("0.10.0" is newer than "0.9.0").
package version

import (
	"strings"

	"golang.org/x/mod/semver"
)

// App is this app's version, which is also its bundled sidecar's: desktop/scripts/bundle.ts links
// npm/aio-proxy/package.json's version with -X, so CFBundleShortVersionString, --version and the
// no-downgrade rule all read one value. Unlinked builds (go test, go run) report a development version
// that is older than every release.
var App = "0.0.0-dev"

// Compare compares two versions by semver precedence. ok is false when either side does not parse,
// which every caller treats as "unknown": never as older, so an unreadable version cannot cause a
// downgrade.
func Compare(a, b string) (cmp int, ok bool) {
	va, okA := canonical(a)
	vb, okB := canonical(b)
	if !okA || !okB {
		return 0, false
	}
	return semver.Compare(va, vb), true
}

// Valid reports whether s is a full semver version (major.minor.patch, optional prerelease and build).
func Valid(s string) bool {
	_, ok := canonical(s)
	return ok
}

// ParseOutput reads `aio-proxy --version` stdout, which is the bare version on one line.
func ParseOutput(stdout string) (string, bool) {
	line, _, _ := strings.Cut(stdout, "\n")
	line = strings.TrimSpace(line)
	if !Valid(line) {
		return "", false
	}
	return line, true
}

// canonical rejects what x/mod/semver accepts but semver does not: a "v" prefix of the input and the
// "1" and "1.2" shorthands. Build metadata is dropped, as it carries no precedence.
func canonical(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" || s[0] == 'v' {
		return "", false
	}
	v := "v" + s
	if !semver.IsValid(v) {
		return "", false
	}
	core, _, _ := strings.Cut(strings.TrimPrefix(semver.Canonical(v), "v"), "-")
	given, _, _ := strings.Cut(s, "+")
	given, _, _ = strings.Cut(given, "-")
	if core != given {
		return "", false
	}
	return v, true
}
