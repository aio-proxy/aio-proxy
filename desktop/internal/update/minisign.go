package update

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/blake2b"
)

// PublicKeyB64 is the release Sparkle Ed25519 key. A rehearsal build replaces it with -X.
var PublicKeyB64 = "qLdzLskOKPgR6CnH2IeR6stMle0fkJIRx64u5wlT2lo="

// keyID is the little-endian form of 0x61696f7072787964 ("dyxrpoia").
var keyID = func() [8]byte {
	var id [8]byte
	binary.LittleEndian.PutUint64(id[:], 0x61696f7072787964)
	return id
}()

// UpdaterPubkey is the base64 minisign public-key text the feed's clients are configured with.
func UpdaterPubkey(rawB64 string) string {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rawB64))
	if err != nil {
		raw = nil
	}
	body := append(append([]byte("Ed"), keyID[:]...), raw...)
	text := "untrusted comment: aio-proxy-desktop update key\n" + base64.StdEncoding.EncodeToString(body) + "\n"
	return base64.StdEncoding.EncodeToString([]byte(text))
}

type Offer struct {
	Version, Target, Asset string
}

// CheckTrusted refuses a signature whose trusted comment was not made for this offer.
func CheckTrusted(signatureField string, offer Offer) error {
	comment, err := trustedComment(signatureField)
	if err != nil {
		return err
	}
	expected := fmt.Sprintf("aio-proxy-desktop %s %s %s", offer.Version, offer.Target, offer.Asset)
	if comment != expected {
		return fmt.Errorf("the signature is for `%s`, not `%s`", comment, expected)
	}
	return nil
}

func trustedComment(signatureField string) (string, error) {
	text, err := base64.StdEncoding.DecodeString(signatureField)
	if err != nil {
		return "", fmt.Errorf("signature is not base64: %w", err)
	}
	lines := strings.Split(strings.TrimRight(string(text), "\n"), "\n")
	if len(lines) < 4 || !strings.HasPrefix(lines[2], "trusted comment: ") {
		return "", errors.New("signature is not minisign")
	}
	return strings.TrimPrefix(lines[2], "trusted comment: "), nil
}

// Verify checks a prehashed minisign signature (algorithm ED) against rawB64's public key.
func Verify(payload []byte, minisigText, rawB64 string) error {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(rawB64))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return errors.New("update key is not a raw Ed25519 public key")
	}
	lines := strings.Split(strings.TrimRight(minisigText, "\n"), "\n")
	if len(lines) < 4 || !strings.HasPrefix(lines[2], "trusted comment: ") {
		return errors.New("signature is not minisign")
	}
	sigLine, err := base64.StdEncoding.DecodeString(lines[1])
	if err != nil {
		return fmt.Errorf("signature is not minisign: %w", err)
	}
	if len(sigLine) != 2+8+ed25519.SignatureSize || string(sigLine[:2]) != "ED" {
		return errors.New("signature is not a prehashed minisign signature")
	}
	global, err := base64.StdEncoding.DecodeString(lines[3])
	if err != nil || len(global) != ed25519.SignatureSize {
		return errors.New("signature is not minisign")
	}
	sig := sigLine[10:]
	comment := strings.TrimPrefix(lines[2], "trusted comment: ")
	digest := blake2b.Sum512(payload)
	if !ed25519.Verify(raw, digest[:], sig) {
		return errors.New("invalid signature")
	}
	if !ed25519.Verify(raw, append(append([]byte{}, sig...), comment...), global) {
		return errors.New("invalid global signature")
	}
	return nil
}
