//go:build windows

package install

import "os"

func executable(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}
