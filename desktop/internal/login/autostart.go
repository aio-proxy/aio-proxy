package login

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const autostartFile = "autostart/aio-proxy-desktop.desktop"

// ExecLine quotes a desktop-entry Exec value.
func ExecLine(appimage string) string {
	var b strings.Builder
	b.WriteString(`Exec="`)
	for _, r := range appimage {
		switch r {
		case '"', '`', '$', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '%':
			b.WriteString("%%")
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func entry(appimage string) string {
	return "[Desktop Entry]\nType=Application\nName=AIO Proxy\n" + ExecLine(appimage) + "\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n"
}

func disabledInPlace(text string) bool {
	for _, line := range strings.Split(text, "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) + "=" + strings.TrimSpace(value) {
		case "Hidden=true", "X-GNOME-Autostart-enabled=false":
			return true
		}
	}
	return false
}

// StatusAt reads an autostart entry. An empty appimage means this process is not an AppImage.
func StatusAt(configHome, appimage string) Status {
	if appimage == "" {
		return Unavailable
	}
	text, err := os.ReadFile(filepath.Join(configHome, autostartFile))
	if err != nil {
		return NotRegistered
	}
	if strings.Contains(string(text), ExecLine(appimage)+"\n") && !disabledInPlace(string(text)) {
		return Enabled
	}
	for _, line := range strings.Split(string(text), "\n") {
		if line == ExecLine(appimage) && !disabledInPlace(string(text)) {
			return Enabled
		}
	}
	return NotRegistered
}

func SetEnabledAt(configHome, appimage string, enabled bool) error {
	if appimage == "" {
		return errors.New("not running from an AppImage")
	}
	path := filepath.Join(configHome, autostartFile)
	if !enabled {
		err := os.Remove(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	return writeEntry(path, entry(appimage))
}

// RefreshExec rewrites Exec when the AppImage moved. A missing entry stays missing, and a disabled one stays disabled.
func RefreshExec(configHome, appimage string) error {
	if appimage == "" {
		return nil
	}
	path := filepath.Join(configHome, autostartFile)
	text, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	if strings.Contains(string(text)+"\n", ExecLine(appimage)+"\n") {
		return nil
	}
	var b strings.Builder
	found := false
	for _, line := range strings.Split(strings.TrimRight(string(text), "\n"), "\n") {
		if strings.HasPrefix(line, "Exec=") {
			found = true
			b.WriteString(ExecLine(appimage))
		} else {
			b.WriteString(line)
		}
		b.WriteByte('\n')
	}
	body := b.String()
	if !found {
		body = entry(appimage)
	}
	return writeEntry(path, body)
}

func writeEntry(path, contents string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(contents), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
