//go:build darwin

package cli

import (
	"fmt"
	"os/exec"
)

func (h *SystemHost) kickstart(string) error {
	cmd := exec.Command("/bin/launchctl", "kickstart", "-k", fmt.Sprintf("gui/%d/%s", h.UID, LaunchdLabel))
	_, err := check(cmd, ServiceTimeout, "launchctl kickstart -k")
	return err
}
