use gpui_kit::{Hsla, Rgba};

use super::tailwind::{OLIVE_500, TEAL_600};

fn srgb(color: super::Oklch) -> [u8; 3] {
    let rgb = Rgba::from(Hsla::from(color));
    [rgb.r, rgb.g, rgb.b].map(|v| (v * 255.0).round() as u8)
}

/// Tailwind publishes these sRGB values; matching them guards the lightness scale (CSS percent
/// versus a 0..1 fraction) and the hue unit.
#[test]
fn palette_converts_to_tailwinds_srgb() {
    assert_eq!(srgb(TEAL_600), [0x00, 0x96, 0x89]);
    assert_eq!(srgb(OLIVE_500), [0x7c, 0x7c, 0x67]);
}
