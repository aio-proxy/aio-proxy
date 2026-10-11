package update

import (
	"encoding/base64"
	"os"
	"strings"
	"testing"
)

func TestBunSignedFixtureVerifies(t *testing.T) {
	payload, err := os.ReadFile("testdata/payload.bin")
	if err != nil {
		t.Fatal(err)
	}
	minisig, err := os.ReadFile("testdata/payload.bin.minisig")
	if err != nil {
		t.Fatal(err)
	}
	keyText, err := os.ReadFile("testdata/pubkey.txt")
	if err != nil {
		t.Fatal(err)
	}
	key := strings.TrimSpace(string(keyText))
	if err := Verify(payload, string(minisig), key); err != nil {
		t.Fatal(err)
	}
	if err := Verify(payload, string(minisig), PublicKeyB64); err == nil {
		t.Fatal("the release key accepted a fixture signed by another key")
	}
	field := base64.StdEncoding.EncodeToString(minisig)
	offer := Offer{Version: "9.9.9", Target: "linux-x86_64", Asset: "payload.bin"}
	if err := CheckTrusted(field, offer); err != nil {
		t.Fatal(err)
	}
	if err := CheckTrusted(field, Offer{Version: "10.0.0", Target: offer.Target, Asset: offer.Asset}); err == nil {
		t.Fatal("a newer label was accepted for an older signature")
	}
}
