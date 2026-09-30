use super::*;

#[test]
fn compacts_counts() {
    assert_eq!(compact(999), "999");
    assert_eq!(compact(1_204), "1.2K");
    assert_eq!(compact(14_815_402), "14.8M");
    assert_eq!(compact(148_000_000), "148M");
    assert_eq!(compact(1_500_000), "1.5M");
    assert_eq!(compact(18_014_398_509_481_985), "18014T");
}

#[test]
fn formats_nano_usd() {
    assert_eq!(usd(20_521_353_840), "$20.52");
    assert_eq!(usd(0), "$0.00");
    assert_eq!(usd(1), "<$0.01");
}
