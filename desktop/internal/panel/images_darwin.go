//go:build darwin

package panel

import nativeimages "github.com/aio-proxy/aio-proxy/desktop/internal/macos/images"

func fetchProvider(source string) (string, []byte, error) {
	response, err := nativeimages.Get(source)
	if err != nil {
		return "", nil, err
	}
	return response.ContentType, response.Body, nil
}

func convertProvider(data []byte) ([]byte, error) { return nativeimages.TIFF(data) }
