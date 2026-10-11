//go:build darwin

// Package images preserves Cocoa's remote-icon transport and fallback bitmap codecs. It is separate
// from the bearer-authenticated, proxy-free loopback transport.
package images

import (
	"errors"
	"fmt"
	"slices"
	"unsafe"

	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
	"github.com/ebitengine/purego/objc"
)

type Response struct {
	Status      int
	ContentType string
	Body        []byte
}
type result struct {
	response Response
	err      error
}

var (
	selShared = objc.RegisterName("sharedSession")
	selURL    = objc.RegisterName("URLWithString:")
	selTask   = objc.RegisterName("dataTaskWithURL:completionHandler:")
	selResume = objc.RegisterName("resume")
	selStatus = objc.RegisterName("statusCode")
	selMIME   = objc.RegisterName("MIMEType")
	selLength = objc.RegisterName("length")
	selBytes  = objc.RegisterName("bytes")
	selData   = objc.RegisterName("dataWithBytes:length:")
)

func dataBytes(data objc.ID) []byte {
	if data == 0 {
		return nil
	}
	n := objc.Send[uintptr](data, selLength)
	if n == 0 {
		return nil
	}
	ptr := objc.Send[unsafe.Pointer](data, selBytes)
	return slices.Clone(unsafe.Slice((*byte)(ptr), n))
}
func nativeData(data []byte) objc.ID {
	return objc.ID(objc.GetClass("NSData")).Send(selData, unsafe.Pointer(unsafe.SliceData(data)), uintptr(len(data)))
}

// Get is blocking; call from a worker. NSURLSession follows the system proxy (including PAC) and
// HTTP cache, as the original desktop image client did. It never receives the desktop credential.
func Get(source string) (Response, error) {
	done := make(chan result, 1)
	var setupError error
	foundation.WithPool(func() {
		url := objc.ID(objc.GetClass("NSURL")).Send(selURL, foundation.NSString(source))
		if url == 0 {
			setupError = errors.New("invalid image URL")
			return
		}
		block := objc.NewBlock(func(_ objc.Block, data, response, nserr objc.ID) {
			r := result{}
			if nserr != 0 {
				r.err = errors.New(foundation.ErrorDescription(nserr))
			} else if response == 0 || !foundation.RespondsTo(response, "statusCode") {
				r.err = errors.New("not an HTTP response")
			} else {
				r.response = Response{Status: objc.Send[int](response, selStatus), ContentType: foundation.GoString(response.Send(selMIME)), Body: dataBytes(data)}
			}
			done <- r
		})
		defer block.Release()
		session := objc.ID(objc.GetClass("NSURLSession")).Send(selShared)
		task := session.Send(selTask, url, block)
		if task == 0 {
			setupError = errors.New("cannot create image request")
			return
		}
		task.Send(selResume)
	})
	if setupError != nil {
		return Response{}, setupError
	}
	r := <-done
	if r.err != nil {
		return Response{}, r.err
	}
	if r.response.Status < 200 || r.response.Status >= 300 {
		return Response{}, fmt.Errorf("icon answered HTTP %d", r.response.Status)
	}
	return r.response, nil
}
