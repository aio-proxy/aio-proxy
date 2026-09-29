import { expect, test } from 'bun:test';

import { DesktopSummaryV1Schema } from './desktop-summary';
import fixture from './fixtures/v1.json' with { type: 'json' };

// The same file is the Rust parser's golden input; a schema change that breaks it breaks the desktop app.
test('the shared v1 fixture is a valid desktop summary', () => {
  expect(DesktopSummaryV1Schema.safeParse(fixture).success).toBe(true);
});
