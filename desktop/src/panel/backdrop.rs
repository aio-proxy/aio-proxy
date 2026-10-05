//! Whether the Windows panel can sit on the system's acrylic backdrop or paints itself opaque.

/// The first build with `DWMWA_SYSTEMBACKDROP_TYPE` (Windows 11 22H2).
const SYSTEM_BACKDROP_BUILD: u32 = 22621;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backdrop {
    Acrylic,
    /// Painted by the theme; the reason goes to the log.
    Opaque(&'static str),
}

/// `build` is 0 when unknown. `transparency` is the user's Transparency effects setting, absent
/// when never written (on by default). Without a hardware adapter DWM draws its effects black.
pub fn backdrop_choice(build: u32, transparency: Option<u32>, software_adapter: bool) -> Backdrop {
    if build < SYSTEM_BACKDROP_BUILD {
        Backdrop::Opaque("Windows build before 22621")
    } else if transparency == Some(0) {
        Backdrop::Opaque("transparency effects off")
    } else if software_adapter {
        Backdrop::Opaque("software adapter")
    } else {
        Backdrop::Acrylic
    }
}

#[cfg(test)]
mod tests;
