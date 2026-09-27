import { createFileRoute } from '@tanstack/react-router';

import { AgentsPage } from '@/modules/agents/templates/agents-page';

export const Route = createFileRoute('/agents/')({ component: AgentsPage });
