// Package login is "start at login" on each platform.
package login

import "errors"

// Status mirrors the macOS SMAppService states. The other platforms use the same names.
type Status int

const (
	NotRegistered Status = iota
	Enabled
	// RequiresApproval: registered, but the user still has to allow it.
	RequiresApproval
	NotFound
	Unavailable
)

func (s Status) String() string {
	switch s {
	case NotRegistered:
		return "NotRegistered"
	case Enabled:
		return "Enabled"
	case RequiresApproval:
		return "RequiresApproval"
	case NotFound:
		return "NotFound"
	default:
		return "Unavailable"
	}
}

// ErrUnavailable is SetEnabled's error when the platform service cannot be reached.
var ErrUnavailable = errors.New("login item service is unavailable")
