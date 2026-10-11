package panel

import (
	"bytes"
	"strings"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/egoist/mygo/ui"
	_ "github.com/sergeymakinen/go-ico" // Remote plugin icons may be ICO, as in the original renderer.
	_ "golang.org/x/image/tiff"         // Previously supported by GPUI; also decodes Cocoa's bitmap fallback.
)

type providerImage struct{ source ui.ImageSource }

// Each model owns its cache. Entries are installed before spawning, so a
// repaint cannot start duplicate loads. Failed loads keep the letter fallback.
var providerImages = make(map[*app.Model]map[string]*providerImage)

func providerImageFor(m *app.Model, source string) ui.ImageSource {
	cache := providerImages[m]
	if cache == nil {
		cache = make(map[string]*providerImage)
		providerImages[m] = cache
	}
	if entry, ok := cache[source]; ok {
		return entry.source
	}
	entry := &providerImage{}
	cache[source] = entry
	go func() {
		image, err := loadProviderImage(source)
		if err != nil {
			return
		}
		// Decode away from the UI thread; only publish and repaint on main. Icon
		// requests use this independent HTTP client, never the desktop bearer.
		m.Post(func() {
			entry.source = image
			if m.Changed != nil {
				m.Changed()
			}
		})
	}()
	return nil
}

func loadProviderImage(source string) (ui.ImageSource, error) {
	contentType, data, err := fetchProvider(source)
	if err != nil {
		return nil, err
	}
	trimmed := bytes.TrimSpace(data)
	if strings.HasPrefix(contentType, "image/svg+xml") || bytes.HasPrefix(trimmed, []byte("<svg")) || bytes.HasPrefix(trimmed, []byte("<?xml")) {
		return ui.ParseSVG(data)
	}
	bitmap, err := ui.DecodeBitmap(data)
	if err == nil {
		return bitmap, nil
	}
	converted, err := convertProvider(data)
	if err != nil {
		return nil, err
	}
	return ui.DecodeBitmap(converted)
}
