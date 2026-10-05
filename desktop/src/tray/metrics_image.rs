//! AppKit text rasterization into the menu bar's 18 pt template image at 2x.

use objc2::AnyThread;
use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2_app_kit::{
    NSAffineTransformNSAppKitAdditions, NSBitmapFormat, NSBitmapImageRep, NSColor, NSDeviceRGBColorSpace, NSFont,
    NSFontAttributeName, NSFontWeightRegular, NSForegroundColorAttributeName, NSGraphicsContext, NSStringDrawing,
};
use objc2_foundation::{NSAffineTransform, NSDictionary, NSPoint, NSString};

use super::{DOT, ICON_HEIGHT, ICON_WIDTH, MetricText, TrayState, icon_rgba};

pub fn render(lines: &[MetricText], show_icon: bool, state: TrayState, dimmed: bool) -> (Vec<u8>, u32, u32) {
    autoreleasepool(|_| {
        let font = NSFont::monospacedDigitSystemFontOfSize_weight(if lines.len() == 1 { 12.0 } else { 9.0 }, unsafe {
            NSFontWeightRegular
        });
        let black = NSColor::blackColor();
        let attributes = NSDictionary::from_slices(
            &[unsafe { NSFontAttributeName }, unsafe { NSForegroundColorAttributeName }],
            &[&*font as &AnyObject, &*black as &AnyObject],
        );
        // The dictionary contains precisely the NSFont and NSColor required by NSString drawing.
        let measure = |text: &str| unsafe { NSString::from_str(text).sizeWithAttributes(Some(&attributes)) };
        let widths = lines.iter().fold([0.0_f64; 3], |mut widths, line| {
            for (index, text) in [line.label, &line.value, line.unit].into_iter().enumerate() {
                widths[index] = widths[index].max(measure(text).width);
            }
            widths
        });
        let gap = measure(" ").width;
        let label_width = if widths[0] > 0.0 { widths[0] + gap } else { 0.0 };
        let unit_width = if widths[2] > 0.0 { gap + widths[2] } else { 0.0 };
        let text_x = if show_icon { f64::from(ICON_WIDTH) / 2.0 + 4.0 } else { 0.0 };
        let text_width = label_width + widths[1] + unit_width;
        // Reserve space for the attention dot even when absent, so attention doesn't shift text.
        let dot_space = if show_icon { 0.0 } else { 4.0 };
        let width = ((text_x + text_width + dot_space) * 2.0).ceil().max(1.0) as u32;
        // AppKit draws into premultiplied RGBA. With black template pixels, its RGB bytes are also
        // valid straight RGBA for tray-icon, so no unpremultiplication is needed.
        // SAFETY: null planes ask AppKit to own the storage; the explicit layout is packed RGBA8.
        let bitmap = unsafe {
            NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bitmapFormat_bytesPerRow_bitsPerPixel(
                NSBitmapImageRep::alloc(), std::ptr::null_mut(), width as isize, ICON_HEIGHT as isize,
                8, 4, true, false, NSDeviceRGBColorSpace, NSBitmapFormat::empty(),
                (width * 4) as isize, 32,
            )
        }.expect("allocate the menu-bar metrics bitmap");
        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&bitmap)
            .expect("create the menu-bar metrics drawing context");
        // SAFETY: AppKit allocated height rows of bytesPerRow bytes, and the bitmap remains alive.
        let length = bitmap.bytesPerRow() as usize * ICON_HEIGHT as usize;
        unsafe {
            std::ptr::write_bytes(bitmap.bitmapData(), 0, length);
        }
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&context));
        // AppKit bitmap contexts start in pixels; scale so font sizes and layout stay in points.
        let scale = NSAffineTransform::new();
        scale.scaleBy(2.0);
        scale.concat();
        let row_height = f64::from(ICON_HEIGHT) / 2.0 / lines.len() as f64;
        for (index, line) in lines.iter().enumerate() {
            let y = (lines.len() - index - 1) as f64 * row_height + (row_height - measure(&line.value).height) / 2.0;
            let value_x = text_x + label_width + widths[1] - measure(&line.value).width;
            for (text, x) in [
                (line.label, text_x),
                (line.value.as_str(), value_x),
                (line.unit, text_x + label_width + widths[1] + gap),
            ] {
                // SAFETY: the attributes have valid types and the bitmap context is current.
                unsafe {
                    NSString::from_str(text).drawAtPoint_withAttributes(NSPoint::new(x, y), Some(&attributes));
                }
            }
        }
        context.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
        // SAFETY: drawing has finished; copy the packed bitmap before its owner is released.
        let mut rgba = unsafe { std::slice::from_raw_parts(bitmap.bitmapData(), length) }.to_vec();
        if show_icon {
            let mark = icon_rgba(state, [0; 3]);
            for y in 0..ICON_HEIGHT as usize {
                let start = y * width as usize * 4;
                let source = y * ICON_WIDTH as usize * 4;
                rgba[start..start + ICON_WIDTH as usize * 4]
                    .copy_from_slice(&mark[source..source + ICON_WIDTH as usize * 4]);
            }
        } else if state == TrayState::Attention {
            let (_, dot_y, dot_r) = DOT;
            let dot_x = width as f32 - dot_r - 0.5;
            for y in 0..ICON_HEIGHT {
                for x in 0..width {
                    let distance = ((x as f32 - dot_x).powi(2) + (y as f32 - dot_y).powi(2)).sqrt();
                    let alpha = ((dot_r + 0.5 - distance).clamp(0.0, 1.0) * 255.0).round() as u8;
                    let offset = ((y * width + x) * 4 + 3) as usize;
                    rgba[offset] = rgba[offset].max(alpha);
                }
            }
        }
        if dimmed {
            for pixel in rgba.as_chunks_mut::<4>().0 {
                pixel[3] = (f32::from(pixel[3]) * 0.4).round() as u8;
            }
        }
        (rgba, width, ICON_HEIGHT)
    })
}
