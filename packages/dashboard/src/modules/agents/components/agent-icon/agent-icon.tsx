import type { AgentTarget } from '@aio-proxy/types';

import { LobeIcon } from '@/components/lobe-icon';

interface AgentIconProps {
  readonly target: AgentTarget;
  readonly size?: number;
  readonly className?: string;
}

// oh-my-pi is a Pi fork without a logo of its own, so it shares Pi's mark.
const SLUGS: Readonly<Record<AgentTarget, string>> = {
  opencode: 'opencode',
  pi: 'pi',
  omp: 'pi',
  codex: 'codex-color',
  grok: 'grok',
};

export const AgentIcon: React.FC<AgentIconProps> = ({ target, size = 20, className }) => (
  <LobeIcon slug={SLUGS[target]} size={size} {...(className === undefined ? {} : { className })} />
);
