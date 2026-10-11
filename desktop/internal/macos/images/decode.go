//go:build darwin

package images

import (
	"errors"
	"sync"

	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

var appKitOnce sync.Once
var appKitError error
var (
	selImageInit = objc.RegisterName("initWithData:")
	selTIFF      = objc.RegisterName("TIFFRepresentation")
)

// TIFF converts a bitmap MyGo does not recognize (notably ICO) using macOS's native image codecs.
// NSImage is used only as a decoder, never drawn or attached to a UI; this runs on the icon worker.
func TIFF(data []byte) ([]byte, error) {
	appKitOnce.Do(func() {
		_, appKitError = purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_GLOBAL|purego.RTLD_NOW)
	})
	if appKitError != nil {
		return nil, appKitError
	}
	var out []byte
	foundation.WithPool(func() {
		image := objc.ID(objc.GetClass("NSImage")).Send(objc.RegisterName("alloc")).Send(selImageInit, nativeData(data))
		if image == 0 {
			return
		}
		defer foundation.Release(image)
		out = dataBytes(image.Send(selTIFF))
	})
	if len(out) == 0 {
		return nil, errors.New("unsupported icon bitmap")
	}
	return out, nil
}
