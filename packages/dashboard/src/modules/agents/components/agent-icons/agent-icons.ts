import type { AgentTarget } from '@aio-proxy/types';

import { withLobeIcon } from '@/components/lobe-icon';

import { OmpIcon } from '../omp-icon';

export const AGENT_ICONS: Readonly<Record<AgentTarget, React.FC<{ size?: number; className?: string }>>> = {
  opencode: withLobeIcon('opencode'),
  pi: withLobeIcon('pi'),
  omp: OmpIcon,
  codex: withLobeIcon('codex-color'),
  grok: withLobeIcon('grok'),
  'claude-code': withLobeIcon('claudecode-color'),
};
