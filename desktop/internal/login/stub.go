//go:build !linux && !darwin && !windows

package login

func Current() Status       { return Unavailable }
func SetEnabled(bool) error { return ErrUnavailable }
func Refresh() error        { return nil }
func OpenSettings()         {}
