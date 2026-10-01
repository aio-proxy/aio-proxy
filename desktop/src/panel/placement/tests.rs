use super::*;

const W: f64 = 360.0;
const MAIN: Frame = Frame { x: 0.0, y: 0.0, width: 3008.0, height: 1692.0 };

fn item(x: f64) -> Frame {
    // The spike's measured status item: 43x33 at the top of a 1692-pt-tall screen.
    Frame { x, y: 1660.0, width: 43.0, height: 33.0 }
}

#[test]
fn centres_the_panel_under_the_icon_below_the_menu_bar() {
    assert_eq!(panel_origin(item(2298.0), MAIN, W), (2140.0, 32.0));
}

#[test]
fn clamps_to_the_right_and_left_screen_edges() {
    assert_eq!(panel_origin(item(2990.0), MAIN, W), (2648.0, 32.0));
    assert_eq!(panel_origin(item(5.0), MAIN, W), (0.0, 32.0));
}

#[test]
fn uses_the_icon_screen_coordinates_on_a_secondary_display() {
    let left_display = Frame { x: -1920.0, y: 200.0, width: 1920.0, height: 1080.0 };
    let icon = Frame { x: -100.0, y: 1256.0, width: 30.0, height: 24.0 };
    assert_eq!(panel_origin(icon, left_display, W), (1560.0, 24.0));
}

#[test]
fn a_screen_narrower_than_the_panel_pins_it_to_the_left_edge() {
    let tiny = Frame { x: 0.0, y: 0.0, width: 300.0, height: 600.0 };
    assert_eq!(panel_origin(Frame { x: 150.0, y: 576.0, width: 20.0, height: 24.0 }, tiny, W), (0.0, 24.0));
}
