//go:build !darwin && !linux && !windows

package update

import "errors"

func installVerified(string, []byte) error {
	return errors.New("updates are not supported on this system")
}
