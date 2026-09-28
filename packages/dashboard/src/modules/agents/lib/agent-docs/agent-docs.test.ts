import { expect, test } from '@rstest/core';

import { agentDocsUrl } from './agent-docs';

test('links each Agent to its guide in the closest published docs language', () => {
  expect(agentDocsUrl('opencode', 'en')).toBe('https://aioproxy.dev/guide/integrations/agents/opencode');
  expect(agentDocsUrl('omp', 'zh-Hant')).toBe('https://aioproxy.dev/zh/guide/integrations/agents/pi-omp');
  expect(agentDocsUrl('codex', 'ja')).toBe('https://aioproxy.dev/guide/integrations/agents/codex');
});
