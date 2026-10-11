// Package format is pure display formatting: counts, money, reset times and
// local calendar days.
package format

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// Compact abbreviates a count with K, M, B or T and one decimal, flooring.
func Compact(n uint64) string {
	units := [...]struct {
		scale uint64
		unit  string
	}{{1_000_000_000_000, "T"}, {1_000_000_000, "B"}, {1_000_000, "M"}, {1_000, "K"}}
	for _, u := range units {
		if n >= u.scale {
			// n/scale*10 + the tenth: n*10 would overflow near the top of uint64.
			tenths := n/u.scale*10 + n%u.scale*10/u.scale
			if tenths >= 1_000 {
				return fmt.Sprintf("%d%s", tenths/10, u.unit)
			}
			return fmt.Sprintf("%d.%d%s", tenths/10, tenths%10, u.unit)
		}
	}
	return strconv.FormatUint(n, 10)
}

// USD is nano-USD to dollars, two decimals; a non-zero amount below a cent
// reads `<$0.01`.
func USD(nano uint64) string {
	cents := nano / 10_000_000
	if cents == 0 && nano > 0 {
		return "<$0.01"
	}
	return fmt.Sprintf("$%d.%02d", cents/100, cents%100)
}

// USDShort is the Cost card's amount: three significant digits, so `≈` and the
// amount fit the card (`$7.46`, `$74.6`, `$746`, `$1.2K`). Floors, as [USD]
// and [Compact] do.
func USDShort(nano uint64) string {
	cents := nano / 10_000_000
	switch {
	case cents == 0 && nano > 0:
		return "<$0.01"
	case cents <= 999:
		return USD(nano)
	case cents <= 9_999:
		return fmt.Sprintf("$%d.%d", cents/100, cents%100/10)
	case cents <= 99_999:
		return fmt.Sprintf("$%d", cents/100)
	default:
		return "$" + Compact(cents/100)
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
