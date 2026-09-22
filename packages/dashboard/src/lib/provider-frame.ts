// Diameter in px of the frame every Provider mark is drawn in — the avatar, each protocol in the
// stack, and the stack's overflow bubble. Kept in one place because those three must agree: the
// frames are what the eye aligns on, so a mismatch reads as icons of different sizes.
export const PROVIDER_FRAME_SIZE = 20;

// The same frame at the quota dialog's larger header scale.
export const PROVIDER_DIALOG_FRAME_SIZE = 32;

// Fraction of an avatar/protocol frame the artwork occupies. Lobe icons ship wildly different
// padding — `codex-color` fills its canvas edge-to-edge while `anthropic` reaches ~70% — so drawing
// them at the frame size makes one Provider's mark look twice another's. Insetting every icon inside
// a same-size frame is what makes them read as one size: the frame aligns, and the leftover padding
// difference is scaled down with the art.
export const PROVIDER_ICON_INSET = 0.75;
