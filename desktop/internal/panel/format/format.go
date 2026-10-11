// Package format is pure display formatting: counts, money, reset times and
// local calendar days.
package format

import (
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
	"time"
)

// Compact abbreviates a count with K, M, B or T and one decimal, flooring.
func Compact(n uint64) string { return CompactDigits(strconv.FormatUint(n, 10)) }

// CompactDigits is Compact for an arbitrary-width decimal.
func CompactDigits(digits string) string {
	n := decimal(digits)
	ten := big.NewInt(10)
	thousand := big.NewInt(1_000)
	for _, u := range []struct {
		scale string
		unit  string
	}{{"1000000000000", "T"}, {"1000000000", "B"}, {"1000000", "M"}, {"1000", "K"}} {
		scale, _ := new(big.Int).SetString(u.scale, 10)
		if n.Cmp(scale) < 0 {
			continue
		}
		q, r := new(big.Int).QuoRem(n, scale, new(big.Int))
		tenths := new(big.Int).Mul(q, ten)
		frac := new(big.Int).Quo(new(big.Int).Mul(r, ten), scale)
		tenths.Add(tenths, frac)
		if tenths.Cmp(thousand) >= 0 {
			return new(big.Int).Quo(tenths, ten).String() + u.unit
		}
		whole, rem := new(big.Int).QuoRem(tenths, ten, new(big.Int))
		return whole.String() + "." + rem.String() + u.unit
	}
	return n.String()
}

func decimal(digits string) *big.Int {
	if digits == "" {
		return new(big.Int)
	}
	n, ok := new(big.Int).SetString(digits, 10)
	if !ok {
		return new(big.Int)
	}
	return n
}

// USD is nano-USD to dollars, two decimals; a non-zero amount below a cent
// reads `<$0.01`.
func USD(nano uint64) string { return USDDigits(strconv.FormatUint(nano, 10)) }

// USDDigits is USD for an arbitrary-width decimal of nano-USD.
func USDDigits(digits string) string {
	nano := decimal(digits)
	cents := new(big.Int).Quo(nano, big.NewInt(10_000_000))
	if cents.Sign() == 0 && nano.Sign() > 0 {
		return "<$0.01"
	}
	dollars, rem := new(big.Int).QuoRem(cents, big.NewInt(100), new(big.Int))
	return fmt.Sprintf("$%s.%02d", dollars.String(), rem.Int64())
}

// USDShort is the Cost card's amount: three significant digits, so `≈` and the
// amount fit the card (`$7.46`, `$74.6`, `$746`, `$1.2K`). Floors, as [USD]
// and [Compact] do.
func USDShort(nano uint64) string { return USDShortDigits(strconv.FormatUint(nano, 10)) }

// USDShortDigits is USDShort for an arbitrary-width decimal of nano-USD.
func USDShortDigits(digits string) string {
	nano := decimal(digits)
	cents := new(big.Int).Quo(new(big.Int).Set(nano), big.NewInt(10_000_000))
	switch {
	case cents.Sign() == 0 && nano.Sign() > 0:
		return "<$0.01"
	case cents.Cmp(big.NewInt(999)) <= 0:
		return USDDigits(digits)
	case cents.Cmp(big.NewInt(9_999)) <= 0:
		dollars, rem := new(big.Int).QuoRem(cents, big.NewInt(100), new(big.Int))
		return fmt.Sprintf("$%s.%d", dollars.String(), new(big.Int).Quo(rem, big.NewInt(10)).Int64())
	case cents.Cmp(big.NewInt(99_999)) <= 0:
		return "$" + new(big.Int).Quo(cents, big.NewInt(100)).String()
	default:
		return "$" + CompactDigits(new(big.Int).Quo(cents, big.NewInt(100)).String())
	}
}

// Percent floors (99.6% remaining is not 100%); the epsilon absorbs binary
// artifacts like 0.29 * 100 = 28.99….
func Percent(ratio float64) string {
	return fmt.Sprintf("%.0f%%", math.Floor(clamp(ratio, 0, 1)*100+1e-9))
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(v, hi)) }

// floorDiv and floorMod are Rust's div_euclid and rem_euclid for a positive
// divisor.
func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b < 0 {
		q--
	}
	return q
}

func floorMod(a, b int64) int64 {
	m := a % b
	if m < 0 {
		m += b
	}
	return m
}

// DaysFromCivil is days since 1970-01-01 for a proleptic Gregorian date
// (Howard Hinnant's algorithm).
func DaysFromCivil(year int64, month, day uint32) int64 {
	if month <= 2 {
		year--
	}
	era := floorDiv(year, 400)
	yoe := year - era*400
	mp := (int64(month) + 9) % 12
	doy := (153*mp+2)/5 + int64(day) - 1
	doe := yoe*365 + yoe/4 - yoe/100 + doy
	return era*146_097 + doe - 719_468
}

// CivilFromDays is the inverse of DaysFromCivil.
func CivilFromDays(days int64) (year int64, month, day uint32) {
	z := days + 719_468
	era := floorDiv(z, 146_097)
	doe := z - era*146_097
	yoe := (doe - doe/1460 + doe/36_524 - doe/146_096) / 365
	doy := doe - (365*yoe + yoe/4 - yoe/100)
	mp := (5*doy + 2) / 153
	day = uint32(doy - (153*mp+2)/5 + 1)
	if mp < 10 {
		month = uint32(mp + 3)
	} else {
		month = uint32(mp - 9)
	}
	year = yoe + era*400
	if month <= 2 {
		year++
	}
	return year, month, day
}

// ParseDate turns `YYYY-MM-DD` into a day number.
func ParseDate(text string) (int64, bool) {
	parts := strings.SplitN(text, "-", 3)
	if len(parts) != 3 {
		return 0, false
	}
	year, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, false
	}
	month, err := strconv.ParseUint(parts[1], 10, 32)
	if err != nil || month < 1 || month > 12 {
		return 0, false
	}
	day, err := strconv.ParseUint(parts[2], 10, 32)
	if err != nil || day < 1 || day > 31 {
		return 0, false
	}
	return DaysFromCivil(year, uint32(month), uint32(day)), true
}

// ParseUTC turns RFC 3339 in UTC (`…Z` or `…+00:00`, as the server's
// `toISOString()` writes) into Unix seconds.
func ParseUTC(text string) (int64, bool) {
	date, clock, ok := strings.Cut(text, "T")
	if !ok {
		return 0, false
	}
	if c, ok := strings.CutSuffix(clock, "Z"); ok {
		clock = c
	} else if c, ok := strings.CutSuffix(clock, "+00:00"); ok {
		clock = c
	} else {
		return 0, false
	}
	clock, _, _ = strings.Cut(clock, ".")
	hms := strings.SplitN(clock, ":", 3)
	if len(hms) != 3 {
		return 0, false
	}
	var v [3]int64
	for i, part := range hms {
		n, err := strconv.ParseInt(part, 10, 64)
		if err != nil {
			return 0, false
		}
		v[i] = n
	}
	days, ok := ParseDate(date)
	if !ok {
		return 0, false
	}
	return days*86_400 + v[0]*3_600 + v[1]*60 + v[2], true
}

// Until is `resetsAt` relative to now: "in 2h 5m", "in 40m", "now".
func Until(now, at int64) string {
	minutes := max(at-now, 0) / 60
	d, h, m := minutes/1_440, minutes/60%24, minutes%60
	switch {
	case d == 0 && h == 0 && m == 0:
		return "now"
	case d == 0 && h == 0:
		return fmt.Sprintf("in %dm", m)
	case d == 0:
		return fmt.Sprintf("in %dh %dm", h, m)
	default:
		return fmt.Sprintf("in %dd %dh", d, h)
	}
}

// UTCOffset is loc's UTC offset in seconds at a Unix time (glue for the pure
// functions above). The offset is looked up per instant because a window can
// span a daylight-saving change.
func UTCOffset(loc *time.Location, unix int64) int64 {
	_, offset := time.Unix(unix, 0).In(loc).Zone()
	return int64(offset)
}

// LocalUTCOffset is the local time zone's UTC offset in seconds at a Unix time.
func LocalUTCOffset(unix int64) int64 { return UTCOffset(time.Local, unix) }
