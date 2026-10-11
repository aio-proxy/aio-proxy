//go:build windows

package cli

func (h *SystemHost) kickstart(home string) error {
	if _, err := check(h.CLI([]string{"service", "stop"}, home), ServiceTimeout, "service stop"); err != nil {
		return err
	}
	_, err := check(h.CLI([]string{"service", "start"}, home), ServiceTimeout, "service start")
	return err
}
