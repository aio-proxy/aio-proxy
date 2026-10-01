import { MINIMUM_MACOS } from '../macho';

export const BUNDLE_ID = 'com.aio-proxy.desktop';
export const DEFAULT_FEED_URL = 'https://github.com/aio-proxy/aio-proxy/releases/download/desktop-feed/appcast.xml';

export type InfoPlistOptions = {
  readonly version: string;
  /** Written only with a public key: without one the app keeps its updater off. */
  readonly sparkle?: { readonly feedUrl: string; readonly publicEdKey: string };
};

const escape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const entry = (key: string, value: string | boolean): string =>
  typeof value === 'boolean'
    ? `  <key>${key}</key><${value}/>`
    : `  <key>${key}</key><string>${escape(value)}</string>`;

/** `SUAutomaticallyUpdate` is never written: a silent install-on-quit would not relaunch the app. */
export function renderInfoPlist({ version, sparkle }: InfoPlistOptions): string {
  const entries: (readonly [string, string | boolean])[] = [
    ['CFBundleIdentifier', BUNDLE_ID],
    ['CFBundleExecutable', 'aio-proxy-desktop'],
    ['CFBundleName', 'AIO Proxy'],
    ['CFBundleDisplayName', 'AIO Proxy'],
    ['CFBundlePackageType', 'APPL'],
    ['CFBundleInfoDictionaryVersion', '6.0'],
    ['CFBundleShortVersionString', version],
    ['CFBundleVersion', version],
    // bundle.ts compiles these with actool: Assets.car on macOS 26+, AppIcon.icns before.
    ['CFBundleIconName', 'AppIcon'],
    ['CFBundleIconFile', 'AppIcon'],
    ['LSUIElement', true],
    ['LSMinimumSystemVersion', MINIMUM_MACOS],
    ['SUAllowsAutomaticUpdates', false],
    ...(sparkle === undefined
      ? []
      : ([
          ['SUFeedURL', sparkle.feedUrl],
          ['SUPublicEDKey', sparkle.publicEdKey],
        ] as const)),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.map(([key, value]) => entry(key, value)).join('\n')}
</dict>
</plist>
`;
}
