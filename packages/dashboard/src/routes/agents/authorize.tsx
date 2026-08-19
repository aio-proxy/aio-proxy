import { createFileRoute } from '@tanstack/react-router';

import { AgentAuthorizationPage } from '@/modules/agent-authorizations/templates/agent-authorization-page';

export const Route = createFileRoute('/agents/authorize')({ component: AgentAuthorizationPage });
