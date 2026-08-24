import { createFileRoute } from '@tanstack/react-router';

import { RoutingPage } from '@/modules/routing/templates/routing-page';

export const Route = createFileRoute('/routing/')({ component: RoutingPage });
