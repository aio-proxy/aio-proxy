//go:build linux

package cli

import "os/exec"

func (h *SystemHost) kickstart(string) error {
	cmd := exec.Command("systemctl", "--user", "restart", "aio-proxy.service")
	_, err := check(cmd, ServiceTimeout, "systemctl --user restart")
	return err
}
