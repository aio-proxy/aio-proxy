//go:build unix

package install

import "os"

func executable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return info.Mode()&0o111 != 0
}
