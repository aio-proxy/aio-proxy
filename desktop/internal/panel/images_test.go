package panel

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/egoist/mygo/ui"
	"golang.org/x/image/tiff"
)

func iconPNGFixture(t *testing.T) []byte {
	t.Helper()
	im := image.NewNRGBA(image.Rect(0, 0, 2, 3))
	im.SetNRGBA(0, 0, color.NRGBA{R: 255, A: 255})
	var b bytes.Buffer
	if err := png.Encode(&b, im); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func assertIcon(t *testing.T, source string) {
	t.Helper()
	decoded, err := loadProviderImage(source)
	if err != nil {
		t.Fatal(err)
	}
	bitmap, ok := decoded.(*ui.Bitmap)
	if !ok {
		t.Fatal("bitmap not decoded")
	}
	w, h := bitmap.Size()
	if w != 2 || h != 3 {
		t.Fatalf("image dimensions %dx%d", w, h)
	}
}
func TestRemoteICOAndTIFFProviderIcons(t *testing.T) {
	pngData := iconPNGFixture(t)
	ico := make([]byte, 22)
	binary.LittleEndian.PutUint16(ico[2:], 1)
	binary.LittleEndian.PutUint16(ico[4:], 1)
	ico[6], ico[7] = 2, 3
	binary.LittleEndian.PutUint16(ico[10:], 1)
	binary.LittleEndian.PutUint16(ico[12:], 32)
	binary.LittleEndian.PutUint32(ico[14:], uint32(len(pngData)))
	binary.LittleEndian.PutUint32(ico[18:], 22)
	ico = append(ico, pngData...)
	bitmap, err := png.Decode(bytes.NewReader(pngData))
	if err != nil {
		t.Fatal(err)
	}
	var tif bytes.Buffer
	if err := tiff.Encode(&tif, bitmap, nil); err != nil {
		t.Fatal(err)
	}
	for _, payload := range []struct {
		kind string
		data []byte
	}{{"image/x-icon", ico}, {"image/tiff", tif.Bytes()}} {
		t.Run(payload.kind, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", payload.kind)
				_, _ = w.Write(payload.data)
			}))
			defer server.Close()
			assertIcon(t, server.URL)
		})
	}
}
