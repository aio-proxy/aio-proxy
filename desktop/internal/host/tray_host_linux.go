//go:build linux

package host

import (
	"github.com/godbus/dbus/v5"

	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
)

const trayWatcher = "org.kde.StatusNotifierWatcher"

// WatchTrayHost reports whether a status-notifier host owns its D-Bus name, now and on every
// change. A D-Bus failure reports that no host is present, so the window opens.
func WatchTrayHost(report func(owned bool)) {
	go func() {
		if err := watchTrayHost(report); err != nil {
			logx.Infof("tray host: D-Bus watch failed: %v", err)
			report(false)
		}
	}()
}

func watchTrayHost(report func(owned bool)) error {
	conn, err := dbus.ConnectSessionBus()
	if err != nil {
		return err
	}
	defer conn.Close()
	// Subscribe before asking, so an owner change between the two is not lost.
	signals := make(chan *dbus.Signal, 8)
	conn.Signal(signals)
	if err := conn.AddMatchSignal(
		dbus.WithMatchInterface("org.freedesktop.DBus"),
		dbus.WithMatchMember("NameOwnerChanged"),
		dbus.WithMatchArg(0, trayWatcher),
	); err != nil {
		return err
	}
	bus := conn.Object("org.freedesktop.DBus", "/org/freedesktop/DBus")
	var owned bool
	if err := bus.Call("org.freedesktop.DBus.NameHasOwner", 0, trayWatcher).Store(&owned); err != nil {
		return err
	}
	report(owned)
	for sig := range signals {
		if sig.Name != "org.freedesktop.DBus.NameOwnerChanged" || len(sig.Body) < 3 {
			continue
		}
		name, _ := sig.Body[0].(string)
		if name != trayWatcher {
			continue
		}
		next, _ := sig.Body[2].(string)
		report(next != "")
	}
	report(false)
	return nil
}
