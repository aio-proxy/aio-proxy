//go:build windows

package install

// VolumeIsReadOnly is unused on Windows: persistence is the sidecar and the stable directory.
func VolumeIsReadOnly(string) bool { return true }
