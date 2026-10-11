package tray

import (
	"bytes"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"math"
	"structs"
	"sync"
	"unsafe"

	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

type textSize struct {
	_             structs.HostLayout
	Width, Height float64
}
type textPoint struct {
	_    structs.HostLayout
	X, Y float64
}

var textDrawing struct {
	once       sync.Once
	font       func(objc.ID, objc.SEL, float64, float64) objc.ID
	measure    func(objc.ID, objc.SEL, objc.ID) textSize
	draw       func(objc.ID, objc.SEL, textPoint, objc.ID)
	scale      func(objc.ID, objc.SEL, float64)
	copyMemory func(unsafe.Pointer, uintptr, uintptr) unsafe.Pointer
	attributes [2]objc.ID
	colorSpace objc.ID
	err        error
}
var (
	textFontSel    = objc.RegisterName("monospacedDigitSystemFontOfSize:weight:")
	textMeasureSel = objc.RegisterName("sizeWithAttributes:")
	textDrawSel    = objc.RegisterName("drawAtPoint:withAttributes:")
	textScaleSel   = objc.RegisterName("scaleBy:")
	textAllocSel   = objc.RegisterName("alloc")
	textBitmapSel  = objc.RegisterName("initWithBitmapDataPlanes:pixelsWide:pixelsHigh:bitsPerSample:samplesPerPixel:hasAlpha:isPlanar:colorSpaceName:bitmapFormat:bytesPerRow:bitsPerPixel:")
	textContextSel = objc.RegisterName("graphicsContextWithBitmapImageRep:")
	textSaveSel    = objc.RegisterName("saveGraphicsState")
	textRestoreSel = objc.RegisterName("restoreGraphicsState")
	textCurrentSel = objc.RegisterName("setCurrentContext:")
	textNewSel     = objc.RegisterName("new")
	textConcatSel  = objc.RegisterName("concat")
	textDataSel    = objc.RegisterName("bitmapData")
	textFlushSel   = objc.RegisterName("flushGraphics")
)

func loadTextDrawing() error {
	textDrawing.once.Do(func() {
		appkit, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			textDrawing.err = err
			return
		}
		purego.RegisterLibFunc(&textDrawing.font, purego.RTLD_DEFAULT, "objc_msgSend")
		purego.RegisterLibFunc(&textDrawing.measure, purego.RTLD_DEFAULT, "objc_msgSend")
		purego.RegisterLibFunc(&textDrawing.draw, purego.RTLD_DEFAULT, "objc_msgSend")
		purego.RegisterLibFunc(&textDrawing.scale, purego.RTLD_DEFAULT, "objc_msgSend")
		purego.RegisterLibFunc(&textDrawing.copyMemory, purego.RTLD_DEFAULT, "memcpy")
		constant := func(name string) objc.ID {
			address, err := purego.Dlsym(appkit, name)
			if err != nil {
				textDrawing.err = err
				return 0
			}
			var value objc.ID
			textDrawing.copyMemory(unsafe.Pointer(&value), address, unsafe.Sizeof(value))
			return value
		}
		keys := [2]objc.ID{constant("NSFontAttributeName"), constant("NSForegroundColorAttributeName")}
		textDrawing.colorSpace = constant("NSDeviceRGBColorSpace")
		if textDrawing.err != nil {
			return
		}
		black := objc.ID(objc.GetClass("NSColor")).Send(objc.RegisterName("blackColor"))
		for i, size := range [2]float64{12, 9} {
			font := textDrawing.font(objc.ID(objc.GetClass("NSFont")), textFontSel, size, 0)
			objects := [2]objc.ID{font, black}
			attributes := objc.ID(objc.GetClass("NSDictionary")).Send(objc.RegisterName("dictionaryWithObjects:forKeys:count:"), uintptr(unsafe.Pointer(&objects[0])), uintptr(unsafe.Pointer(&keys[0])), uintptr(2))
			textDrawing.attributes[i] = attributes.Send(objc.RegisterName("retain"))
		}
	})
	return textDrawing.err
}

// AppKit rasterizes the same 18-point, 2x template image as the reference app.
// Text is 9 pt for two rows, 12 pt for one; labels share a column with left-aligned values.
func metricsPNG(rows []menubar.MetricRow, mark image.Image, dimmed bool) (data []byte, err error) {
	foundation.WithPool(func() {
		if err = loadTextDrawing(); err != nil {
			return
		}
		attributes := textDrawing.attributes[0]
		if len(rows) == 2 {
			attributes = textDrawing.attributes[1]
		}
		var strings [2][3]objc.ID
		var sizes [2][3]textSize
		gap := textDrawing.measure(foundation.NSString(" "), textMeasureSel, attributes).Width
		labelWidth, valueWidth := 0.0, 0.0
		for i, row := range rows {
			for j, value := range [3]string{row.Label, row.Value, row.Unit} {
				strings[i][j] = foundation.NSString(value)
				sizes[i][j] = textDrawing.measure(strings[i][j], textMeasureSel, attributes)
			}
			labelWidth = max(labelWidth, sizes[i][0].Width)
			valueWidth = max(valueWidth, sizes[i][1].Width+gap+sizes[i][2].Width)
		}
		labelWidth += gap
		textX := 0.0
		if mark != nil {
			textX = float64(IconWidth)/2 + 4
		}
		width := int(math.Ceil((textX + labelWidth + valueWidth) * 2))
		bitmap := objc.ID(objc.GetClass("NSBitmapImageRep")).Send(textAllocSel).Send(textBitmapSel, uintptr(0), width, IconHeight, 8, 4, uintptr(1), uintptr(0), textDrawing.colorSpace, uintptr(0), width*4, 32)
		if bitmap == 0 {
			err = fmt.Errorf("allocate menu-bar text bitmap")
			return
		}
		defer foundation.Release(bitmap)
		contextClass := objc.ID(objc.GetClass("NSGraphicsContext"))
		context := contextClass.Send(textContextSel, bitmap)
		if context == 0 {
			err = fmt.Errorf("create menu-bar text context")
			return
		}
		pixels := unsafe.Slice((*byte)(objc.Send[unsafe.Pointer](bitmap, textDataSel)), width*IconHeight*4)
		clear(pixels)
		contextClass.Send(textSaveSel)
		defer contextClass.Send(textRestoreSel)
		contextClass.Send(textCurrentSel, context)
		transform := objc.ID(objc.GetClass("NSAffineTransform")).Send(textNewSel)
		defer foundation.Release(transform)
		textDrawing.scale(transform, textScaleSel, 2)
		transform.Send(textConcatSel)
		rowHeight := float64(IconHeight) / 2 / float64(len(rows))
		for i := range rows {
			y := float64(len(rows)-i-1)*rowHeight + (rowHeight-sizes[i][1].Height)/2
			valueX := textX + labelWidth
			positions := [3]float64{textX, valueX, valueX + sizes[i][1].Width + gap}
			for j, x := range positions {
				textDrawing.draw(strings[i][j], textDrawSel, textPoint{X: x, Y: y}, attributes)
			}
		}
		context.Send(textFlushSel)
		// Black premultiplied template pixels are also valid straight RGBA; PNG encoding
		// finishes while AppKit still owns the bitmap, without copying the whole buffer.
		im := &image.NRGBA{Pix: pixels, Stride: width * 4, Rect: image.Rect(0, 0, width, IconHeight)}
		if mark != nil {
			draw.Draw(im, image.Rect(0, 0, IconWidth, IconHeight), mark, image.Point{}, draw.Src)
		}
		if dimmed {
			for i := 3; i < len(im.Pix); i += 4 {
				im.Pix[i] = uint8(math.Round(float64(im.Pix[i]) * 0.4))
			}
		}
		var output bytes.Buffer
		err = png.Encode(&output, im)
		data = output.Bytes()
	})
	return
}
