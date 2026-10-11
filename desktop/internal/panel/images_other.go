//go:build !darwin

package panel

import (
	"fmt"
	"io"
	"net/http"
	"time"
)

func fetchProvider(source string) (string, []byte, error) {
	client := &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{Proxy: nil}}
	response, err := client.Get(source)
	if err != nil {
		return "", nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return "", nil, err
	}
	if response.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("icon status %d", response.StatusCode)
	}
	return response.Header.Get("Content-Type"), body, nil
}

func convertProvider([]byte) ([]byte, error) {
	return nil, fmt.Errorf("unsupported icon encoding")
}
