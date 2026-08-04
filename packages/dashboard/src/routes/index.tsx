import { createFileRoute } from '@tanstack/react-router';

import { OverviewPage } from '@/modules/overview/templates/overview-page';

export const Route = createFileRoute('/')({ component: OverviewPage });
