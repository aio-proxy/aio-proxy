import type { AgentTarget } from '@aio-proxy/types';

const DOCS_ORIGIN = 'https://aioproxy.dev';

// Pi and oh-my-pi share one guide on the docs site.
const PAGES: Readonly<Record<AgentTarget, string>> = {
  opencode: 'opencode',
  pi: 'pi-omp',
  omp: 'pi-omp',
  codex: 'codex',
  grok: 'grok',
  'claude-code': 'claude-code',
};

/** The Agent's setup guide; the docs site is published in English and Simplified Chinese only. */
export const agentDocsUrl = (target: AgentTarget, locale: string): string =>
  `${DOCS_ORIGIN}${locale.startsWith('zh') ? '/zh' : ''}/guide/integrations/agents/${PAGES[target]}`;
