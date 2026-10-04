use super::*;

#[test]
fn acrylic_on_windows_11_22h2_with_a_gpu_and_transparency_on_or_unset() {
    assert_eq!(backdrop_choice(22621, Some(1), false), Backdrop::Acrylic);
    assert_eq!(backdrop_choice(26100, None, false), Backdrop::Acrylic);
}

#[test]
fn opaque_wherever_the_backdrop_could_render_black() {
    for (build, transparency, software) in
        [(22000, Some(1), false), (0, None, false), (26100, Some(0), false), (26100, Some(1), true)]
    {
        assert!(matches!(backdrop_choice(build, transparency, software), Backdrop::Opaque(_)));
    }
}
