package token

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestPrintedFormsAreRedacted(t *testing.T) {
	tok := New("s3cr3t-desktop-token")
	encoded, err := json.Marshal(struct{ Token Token }{tok})
	if err != nil {
		t.Fatal(err)
	}
	printed := fmt.Sprintf("%v %+v %#v %s %v", tok, tok, tok, tok, &tok) + string(encoded)
	if strings.Contains(printed, "s3cr3t") {
		t.Fatal(printed)
	}
}

func TestDecodesFromAJSONString(t *testing.T) {
	var v struct {
		Token Token `json:"token"`
	}
	if err := json.Unmarshal([]byte(`{"token":"abc"}`), &v); err != nil || v.Token.Expose() != "abc" {
		t.Fatalf("%v %q", err, v.Token.Expose())
	}
}
