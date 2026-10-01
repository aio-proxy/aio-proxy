import { expect, test } from 'bun:test';

import { renderInfoPlist } from './info-plist';

test('updates are user-driven: automatic updates are off and never silently installed', () => {
  const plist = renderInfoPlist({
    version: '0.37.0',
    sparkle: { feedUrl: 'https://example.test/appcast.xml', publicEdKey: 'KEY=' },
  });
  expect(plist).toContain('<key>SUAllowsAutomaticUpdates</key><false/>');
  expect(plist).not.toContain('SUAutomaticallyUpdate');
  expect(plist).toContain('<key>LSUIElement</key><true/>');
  expect(plist).toContain('<key>LSMinimumSystemVersion</key><string>13.0</string>');
  expect(plist).toContain('<key>CFBundleVersion</key><string>0.37.0</string>');
});

test('without a public key the feed is left out, so the app keeps its updater off', () => {
  const plist = renderInfoPlist({ version: '0.37.0' });
  expect(plist).not.toContain('SUFeedURL');
  expect(plist).not.toContain('SUPublicEDKey');
});
