//go:build windows

package update

import (
	"errors"
	"os"
	"os/exec"
)

// Passive NSIS: a progress window, then relaunch. /R is the packager's relaunch flag.
func installVerified(_ string, body []byte) error {
	file, err := os.CreateTemp("", "aio-proxy-update-*.exe")
	if err != nil {
		return err
	}
	path := file.Name()
	if _, err := file.Write(body); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	cmd := exec.Command(path, "/P", "/R")
	if err := cmd.Start(); err != nil {
		return errors.New("the installer did not start")
	}
	os.Exit(0)
	return nil
}
