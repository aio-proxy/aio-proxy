package live

import (
	"fmt"
	"math"
	"math/big"

	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
)

func Format(metric menubar.Metric, snap Snapshot) menubar.MetricRow {
	switch metric {
	case menubar.TodayTokens:
		return menubar.MetricRow{Label: "TOK", Value: tokens(snap.TodayTokens), Unit: "tok"}
	case menubar.TokensPerSecond:
		return menubar.MetricRow{Label: "TPS", Value: rate(snap.OutputTokensPerSecond), Unit: "tok/s"}
	case menubar.TodayCost:
		return menubar.MetricRow{Label: "COST", Value: cost(snap.TodayCostNanoUsd), Unit: ""}
	case menubar.InFlight:
		return menubar.MetricRow{Label: "REQ", Value: fmt.Sprintf("%d", snap.InFlight), Unit: "req"}
	default:
		return menubar.MetricRow{Value: "—"}
	}
}

func rate(value float64) string {
	tenths := math.Round(value*10) / 10
	if tenths < 100 {
		return fmt.Sprintf("%.1f", tenths)
	}
	return fmt.Sprintf("%.0f", math.Round(value))
}

func cost(nano *big.Int) string {
	if nano == nil {
		nano = new(big.Int)
	}
	cents := rounded(nano, big.NewInt(10_000_000))
	if cents.Cmp(big.NewInt(10_000)) < 0 {
		c := cents.Int64()
		return fmt.Sprintf("$%d.%02d", c/100, c%100)
	}
	return "$" + rounded(nano, big.NewInt(1_000_000_000)).String()
}

func tokens(value *big.Int) string {
	if value == nil {
		value = new(big.Int)
	}
	type unit struct {
		scale  *big.Int
		suffix string
	}
	units := []unit{{big.NewInt(1_000), "K"}, {big.NewInt(1_000_000), "M"}, {big.NewInt(1_000_000_000), "B"}}
	for index := len(units) - 1; index >= 0; index-- {
		scale, suffix := units[index].scale, units[index].suffix
		if value.Cmp(scale) < 0 {
			continue
		}
		decimals := 0
		tier := new(big.Int).Quo(value, scale)
		switch {
		case tier.Cmp(big.NewInt(10)) < 0:
			decimals = 2
		case tier.Cmp(big.NewInt(100)) < 0:
			decimals = 1
		}
		factor := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(decimals)), nil)
		amount := rounded(value, new(big.Int).Quo(scale, factor))
		if amount.Cmp(big.NewInt(1_000)) == 0 {
			if decimals > 0 {
				amount = new(big.Int).Quo(amount, big.NewInt(10))
				decimals--
				factor = new(big.Int).Quo(factor, big.NewInt(10))
			} else if index+1 < len(units) {
				amount = big.NewInt(100)
				decimals = 2
				factor = big.NewInt(100)
				suffix = units[index+1].suffix
			}
		}
		if decimals == 0 {
			return amount.String() + suffix
		}
		whole := new(big.Int).Quo(amount, factor)
		frac := new(big.Int).Mod(amount, factor)
		return fmt.Sprintf("%s.%0*d%s", whole, decimals, frac.Int64(), suffix)
	}
	return value.String()
}

// rounded divides before rounding so a large counter never overflows.
func rounded(value, divisor *big.Int) *big.Int {
	q, r := new(big.Int).QuoRem(new(big.Int).Set(value), divisor, new(big.Int))
	half := new(big.Int).Rsh(new(big.Int).Set(divisor), 1)
	if r.Cmp(half) >= 0 {
		q.Add(q, big.NewInt(1))
	}
	return q
}
