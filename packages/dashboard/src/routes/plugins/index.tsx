import { createFileRoute } from '@tanstack/react-router';

import { PluginsPage } from '@/modules/plugins/templates/plugins-page';

export const Route = createFileRoute('/plugins/')({ component: PluginsPage });
