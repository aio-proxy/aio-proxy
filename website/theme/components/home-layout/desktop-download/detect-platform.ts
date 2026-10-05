export type DesktopPlatform = 'macos' | 'windows' | 'linux-x86_64' | 'linux-aarch64';

// Browsers do not reliably expose Intel vs Apple Silicon or Windows on Arm, so those get the one build there
// is and the note under the button states the requirement. iPadOS and iOS report "Mac OS X", so touch
// support tells them apart; Android and ChromeOS report Linux but cannot run an AppImage.
export function detectPlatform(userAgent: string, maxTouchPoints: number): DesktopPlatform | undefined {
  if (/Android|CrOS/u.test(userAgent)) return undefined;
  if (/Mac/u.test(userAgent)) return maxTouchPoints <= 1 ? 'macos' : undefined;
  if (/Windows/u.test(userAgent)) return 'windows';
  if (!/Linux/u.test(userAgent)) return undefined;
  if (/aarch64|arm64/u.test(userAgent)) return 'linux-aarch64';
  // 32-bit x86 and ARM (i686, armv7l) have no build.
  return /x86_64/u.test(userAgent) ? 'linux-x86_64' : undefined;
}
