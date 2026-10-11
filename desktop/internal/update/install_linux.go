//go:build linux

package update

import (
	"fmt"
	"os"
	"syscall"
)

func installVerified(_ string, body []byte) error {
	path := os.Getenv("APPIMAGE")
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	backup := path + ".aio-proxy-previous"
	if err := os.Rename(path, backup); err != nil {
		return err
	}
	if err := os.WriteFile(path, body, info.Mode()); err != nil {
		_ = os.Rename(backup, path)
		return err
	}
	_ = os.Remove(backup)
	err = syscall.Exec(path, []string{path}, os.Environ())
	report(fmt.Sprintf("Updated, but could not relaunch: %v. Quit and reopen AIO Proxy.", err), true)
	return nil
}
