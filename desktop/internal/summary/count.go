package summary

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
	"strings"
)

// Count is a non-negative integer carried as a decimal string. The wire contract is unbounded;
// the server aggregates with bigint. The zero value is 0. Compare with Cmp or EqualUint.
type Count struct {
	// digits is the canonical decimal with no leading zeros. Empty means 0.
	digits string
}

// CountOf builds a count from a value that fits in a uint64.
func CountOf(n uint64) Count {
	if n == 0 {
		return Count{}
	}
	return Count{digits: strconv.FormatUint(n, 10)}
}

func (c Count) String() string {
	if c.digits == "" {
		return "0"
	}
	return c.digits
}

func (c Count) IsZero() bool { return c.digits == "" }

func (c Count) EqualUint(n uint64) bool { return c.Cmp(CountOf(n)) == 0 }

// Cmp reports the sign of c - o.
func (c Count) Cmp(o Count) int {
	a, b := c.String(), o.String()
	if len(a) != len(b) {
		if len(a) < len(b) {
			return -1
		}
		return 1
	}
	return strings.Compare(a, b)
}

func (c Count) Add(o Count) Count { return countFrom(new(big.Int).Add(c.int(), o.int())) }

// Sub is c - o. o larger than c yields 0.
func (c Count) Sub(o Count) Count {
	if c.Cmp(o) < 0 {
		return Count{}
	}
	return countFrom(new(big.Int).Sub(c.int(), o.int()))
}

func (c Count) Mul(n uint64) Count {
	return countFrom(new(big.Int).Mul(c.int(), new(big.Int).SetUint64(n)))
}

// Quo is integer division. Division by zero yields 0.
func (c Count) Quo(o Count) Count {
	if o.IsZero() {
		return Count{}
	}
	return countFrom(new(big.Int).Quo(c.int(), o.int()))
}

// Float64 is for ratios. Integers above 2^53 are approximate.
func (c Count) Float64() float64 {
	f, _, err := big.ParseFloat(c.String(), 10, 64, big.ToZero)
	if err != nil || f == nil {
		return 0
	}
	v, _ := f.Float64()
	return v
}

func (c Count) int() *big.Int {
	n, ok := new(big.Int).SetString(c.String(), 10)
	if !ok {
		return new(big.Int)
	}
	return n
}

func countFrom(n *big.Int) Count {
	if n.Sign() <= 0 {
		return Count{}
	}
	return Count{digits: n.String()}
}

func (c *Count) UnmarshalJSON(data []byte) error {
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return errors.New("invalid type: null, expected a string")
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	if text == "" {
		return errors.New("invalid count \"\"")
	}
	for _, r := range text {
		if r < '0' || r > '9' {
			return fmt.Errorf("invalid count %q", text)
		}
	}
	text = strings.TrimLeft(text, "0")
	c.digits = text
	return nil
}
