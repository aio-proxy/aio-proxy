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

const WORK: Rect = Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1032.0 }; // taskbar at the bottom
const PANEL: (f64, f64) = (360.0, 560.0);

#[test]
fn bottom_taskbar_opens_above_the_icon_clamped_to_the_right_edge() {
    let icon = Rect { x: 1880.0, y: 1040.0, width: 24.0, height: 32.0 };
    assert_eq!(popup_origin(icon, WORK, PANEL), (1920.0 - 360.0, 1032.0 - 560.0));
}

#[test]
fn top_taskbar_opens_below_the_icon() {
    let work = Rect { x: 0.0, y: 48.0, width: 1920.0, height: 1032.0 };
    let icon = Rect { x: 900.0, y: 8.0, width: 24.0, height: 32.0 };
    assert_eq!(popup_origin(icon, work, PANEL), (912.0 - 180.0, 48.0));
}

#[test]
fn left_and_right_taskbars_open_beside_the_icon() {
    let work_l = Rect { x: 60.0, y: 0.0, width: 1860.0, height: 1080.0 };
    assert_eq!(
        popup_origin(Rect { x: 10.0, y: 900.0, width: 32.0, height: 24.0 }, work_l, PANEL),
        (60.0, 1080.0 - 560.0)
    );
    let work_r = Rect { x: 0.0, y: 0.0, width: 1860.0, height: 1080.0 };
    // Centered would be -168, clamped to the top.
    assert_eq!(
        popup_origin(Rect { x: 1878.0, y: 100.0, width: 32.0, height: 24.0 }, work_r, PANEL),
        (1860.0 - 360.0, 0.0)
    );
}

#[test]
fn an_overflow_icon_inside_the_work_area_opens_toward_the_screen_center() {
    let icon = Rect { x: 1700.0, y: 900.0, width: 24.0, height: 24.0 }; // in the overflow flyout
    assert_eq!(popup_origin(icon, WORK, PANEL), (1712.0 - 180.0, 900.0 - 560.0));
}

#[test]
fn physical_rects_are_scaled_to_logical_before_placement() {
    let phys = Rect { x: 2820.0, y: 1560.0, width: 36.0, height: 48.0 };
    assert_eq!(to_logical(phys, 1.5), Rect { x: 1880.0, y: 1040.0, width: 24.0, height: 32.0 });
}

#[test]
fn a_monitor_left_of_the_primary_has_negative_coordinates() {
    let work = Rect { x: -1920.0, y: 0.0, width: 1920.0, height: 1032.0 };
    let icon = Rect { x: -40.0, y: 1040.0, width: 24.0, height: 32.0 };
    assert_eq!(popup_origin(icon, work, PANEL), (-360.0, 472.0));
}

#[test]
fn an_icon_in_the_upper_half_of_the_work_area_opens_below_it() {
    let icon = Rect { x: 1700.0, y: 100.0, width: 24.0, height: 24.0 };
    assert_eq!(popup_origin(icon, WORK, PANEL), (1712.0 - 180.0, 124.0));
}
